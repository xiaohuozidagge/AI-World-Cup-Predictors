/**
 * Tests for the in-season Premier League fixture sync engine.
 *
 * The diff computation is pure (no I/O), so most cases run against an in-memory
 * snapshot. The apply / idempotency / dry-run cases write a snapshot into a
 * temporary directory and exercise `applySnapshot` against it — no real
 * `data/football` is ever touched, and no network or token is used.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  computeSyncDiff,
  applySnapshot,
  buildProposedManifest,
  loadLocalSnapshot,
  MATCH_COUNT_MISMATCH,
  DUPLICATE_MATCH,
  TEAM_IDENTITY_MISMATCH,
  NON_PL_COMPETITION,
  UNKNOWN_STATUS,
  FINISHED_SCORE_CORRECTION_REQUIRED,
  INVALID_SCORE,
  WINNER_SCORE_MISMATCH,
  FINISHED_REGRESSION,
  INVALID_LAST_UPDATED,
  type LocalSnapshot,
} from "./fixture-sync"
import type { Competition, Fixture, Team } from "../supabase/types"
import type { StaticManifest } from "./static-types"
import type { Match } from "../football-data/types"

const PL_ID = "cb5d6d33-9375-49f5-8cbd-d59754222a97"
const PROVIDER_ID = 2021

// --- factories ---------------------------------------------------------------

function makeCompetition(overrides: Partial<Competition> = {}): Competition {
  return {
    id: PL_ID,
    provider: "football-data",
    provider_competition_id: PROVIDER_ID,
    slug: "premier-league",
    name: "Premier League",
    short_name: "EPL",
    country: "England",
    competition_type: "LEAGUE",
    current_season: 2026,
    logo_url: null,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function makeTeam(providerTeamId: number, slug: string): Team {
  return {
    id: `team-${providerTeamId}`,
    provider: "football-data",
    provider_team_id: providerTeamId,
    name: `Team ${providerTeamId}`,
    short_name: slug.toUpperCase(),
    slug,
    country: "England",
    logo_url: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }
}

function makeFixture(overrides: Partial<Fixture> & { providerFixtureId: number }): Fixture {
  const { providerFixtureId, ...rest } = overrides
  return {
    id: `fx-${providerFixtureId}`,
    provider: "football-data",
    provider_fixture_id: providerFixtureId,
    competition_id: PL_ID,
    season: 2026,
    round: null,
    matchweek: (providerFixtureId % 38) + 1,
    stage: "REGULAR_SEASON",
    home_team_id: "team-1",
    away_team_id: "team-2",
    kickoff_at: "2026-08-21T19:00:00Z",
    venue_name: null,
    venue_city: null,
    status: "SCHEDULED",
    elapsed_minutes: null,
    home_score: null,
    away_score: null,
    halftime_home_score: null,
    halftime_away_score: null,
    fulltime_home_score: null,
    fulltime_away_score: null,
    winner_team_id: null,
    source_updated_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...rest,
  }
}

function makeManifest(fixtureCount: number): StaticManifest {
  return {
    schemaVersion: 1,
    provider: "football-data",
    exportedAt: "2026-01-01T00:00:00Z",
    sourceLastUpdatedAt: null,
    counts: {
      competitions: 1,
      teams: 2,
      fixtures: fixtureCount,
      finishedFixtures: 0,
      scheduledFixtures: fixtureCount,
    },
    competitions: [
      {
        slug: "premier-league",
        season: 2026,
        teams: 2,
        fixtures: fixtureCount,
        finishedFixtures: 0,
        upcomingFixtures: fixtureCount,
      },
    ],
  }
}

function makeSnapshot(fixtures: Fixture[], teams?: Team[]): LocalSnapshot {
  return {
    competitions: [makeCompetition()],
    teams: teams ?? [makeTeam(1, "team-one"), makeTeam(2, "team-two")],
    fixtures,
    manifest: makeManifest(fixtures.length),
  }
}

function makeMatch(overrides: Partial<Match> & { id: number }): Match {
  const { id, ...rest } = overrides
  return {
    id,
    utcDate: "2026-08-21T19:00:00Z",
    status: "SCHEDULED",
    matchday: (id % 38) + 1,
    stage: "REGULAR_SEASON",
    group: null,
    lastUpdated: "2026-09-18T00:20:33Z",
    homeTeam: { id: 1, name: "Team 1", shortName: "ONE", tla: "ONE", crest: null },
    awayTeam: { id: 2, name: "Team 2", shortName: "TWO", tla: "TWO", crest: null },
    score: { winner: null, duration: "REGULAR", fullTime: { home: null, away: null }, halfTime: { home: null, away: null } },
    ...rest,
  }
}

function finishedScore(home: number, away: number, winner: "HOME_TEAM" | "AWAY_TEAM" | "DRAW") {
  return { winner, duration: "REGULAR", fullTime: { home, away }, halfTime: { home: 0, away: 0 } }
}

// --- temp dir helpers --------------------------------------------------------

function writeSnapshotToTemp(snapshot: LocalSnapshot): string {
  const root = mkdtempSync(join(tmpdir(), "pl-sync-"))
  const dir = join(root, "data", "football")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "competitions.json"), JSON.stringify(snapshot.competitions, null, 2))
  writeFileSync(join(dir, "teams.json"), JSON.stringify(snapshot.teams, null, 2))
  writeFileSync(join(dir, "fixtures.json"), JSON.stringify(snapshot.fixtures, null, 2))
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(snapshot.manifest, null, 2))
  return root
}

function fullSeason() {
  const teams = Array.from({ length: 20 }, (_, i) => makeTeam(i + 1, `team-${i + 1}`))
  const fixtures: Fixture[] = []
  const matches: Match[] = []
  for (let k = 0; k < 380; k++) {
    const providerFixtureId = k + 1
    const homeProvider = (k % 20) + 1
    const awayProvider = ((k + 1) % 20) + 1
    const kickoff = new Date(Date.UTC(2026, 7, 1) + k * 86400000).toISOString()
    fixtures.push(
      makeFixture({
        providerFixtureId,
        home_team_id: `team-${homeProvider}`,
        away_team_id: `team-${awayProvider}`,
        kickoff_at: kickoff,
      }),
    )
    matches.push(
      makeMatch({
        id: providerFixtureId,
        utcDate: kickoff,
        homeTeam: { id: homeProvider, name: `Team ${homeProvider}`, shortName: null, tla: null, crest: null },
        awayTeam: { id: awayProvider, name: `Team ${awayProvider}`, shortName: null, tla: null, crest: null },
      }),
    )
  }
  return { teams, fixtures, matches }
}

// --- tests -------------------------------------------------------------------

test("full 380-fixture season maps one-to-one with no changes", () => {
  const { teams, fixtures, matches } = fullSeason()
  const diff = computeSyncDiff(matches, makeSnapshot(fixtures, teams))
  assert.equal(diff.ok, true)
  assert.equal(diff.safeToApply, true)
  assert.equal(diff.counts.apiMatches, 380)
  assert.equal(diff.counts.localMatches, 380)
  assert.equal(diff.counts.unchanged, 380)
  assert.equal(diff.changes.length, 0)
  assert.equal(diff.hardFailures.length, 0)
})

test("duplicate local provider id is rejected", () => {
  const f1 = makeFixture({ providerFixtureId: 1 })
  const f2 = makeFixture({ providerFixtureId: 1 })
  const matches = [makeMatch({ id: 1 }), makeMatch({ id: 2 })]
  const diff = computeSyncDiff(matches, makeSnapshot([f1, f2]))
  assert.equal(diff.ok, false)
  assert.ok(diff.hardFailures.some((e) => e.code === DUPLICATE_MATCH))
})

test("home/away team identity mismatch is rejected", () => {
  const fixture = makeFixture({ providerFixtureId: 1, home_team_id: "team-1", away_team_id: "team-2" })
  // API says the home team is provider id 3, which maps to a different team.
  const match = makeMatch({ id: 1, homeTeam: { id: 3, name: "Team 3", shortName: null, tla: null, crest: null } })
  const diff = computeSyncDiff([match], makeSnapshot([fixture]))
  assert.equal(diff.ok, false)
  assert.ok(diff.hardFailures.some((e) => e.code === TEAM_IDENTITY_MISMATCH))
})

test("dry-run computation never writes the snapshot files", () => {
  const { teams, fixtures, matches } = fullSeason()
  const snapshot = makeSnapshot(fixtures, teams)
  const root = writeSnapshotToTemp(snapshot)
  const beforeFixtures = readFileSync(join(root, "data", "football", "fixtures.json"), "utf8")
  const beforeManifest = readFileSync(join(root, "data", "football", "manifest.json"), "utf8")

  const diff = computeSyncDiff(matches, loadLocalSnapshot(root))
  assert.equal(diff.ok, true)

  const afterFixtures = readFileSync(join(root, "data", "football", "fixtures.json"), "utf8")
  const afterManifest = readFileSync(join(root, "data", "football", "manifest.json"), "utf8")
  assert.equal(afterFixtures, beforeFixtures)
  assert.equal(afterManifest, beforeManifest)
})

test("apply writes fixtures + manifest atomically with no .tmp residue", () => {
  const team1 = makeTeam(1, "team-one")
  const team2 = makeTeam(2, "team-two")
  const fixture = makeFixture({ providerFixtureId: 1, home_team_id: team1.id, away_team_id: team2.id, status: "LIVE" })
  const match = makeMatch({
    id: 1,
    status: "FINISHED",
    score: finishedScore(2, 1, "HOME_TEAM"),
    lastUpdated: "2026-09-19T00:00:00Z",
  })
  const snapshot = makeSnapshot([fixture], [team1, team2])
  const root = writeSnapshotToTemp(snapshot)

  const diff = computeSyncDiff([match], loadLocalSnapshot(root))
  assert.equal(diff.ok, true)
  assert.equal(diff.safeToApply, true)
  assert.ok(diff.changes.length > 0)

  const manifest = buildProposedManifest({
    snapshot: loadLocalSnapshot(root),
    fixtures: diff.proposedFixtures,
    sourceLastUpdatedAt: diff.sourceLastUpdatedAt,
    exportedAt: "2026-09-19T00:00:00Z",
  })
  applySnapshot(diff.proposedFixtures, manifest, root)

  const reloaded = loadLocalSnapshot(root)
  const written = reloaded.fixtures.find((f) => f.provider_fixture_id === 1)
  assert.equal(written?.status, "FINISHED")
  assert.equal(written?.fulltime_home_score, 2)
  assert.equal(written?.fulltime_away_score, 1)
  assert.equal(reloaded.manifest.counts.finishedFixtures, 1)

  const leftovers = readdirSync(join(root, "data", "football")).filter((n) => n.endsWith(".tmp"))
  assert.deepEqual(leftovers, [])
})

test("idempotent: identical input yields identical hashes and a no-op second apply", () => {
  const team1 = makeTeam(1, "team-one")
  const team2 = makeTeam(2, "team-two")
  const fixture = makeFixture({ providerFixtureId: 1, home_team_id: team1.id, away_team_id: team2.id, status: "LIVE" })
  const match = makeMatch({
    id: 1,
    status: "FINISHED",
    score: finishedScore(2, 1, "HOME_TEAM"),
    lastUpdated: "2026-09-19T00:00:00Z",
  })
  const snapshot = makeSnapshot([fixture], [team1, team2])

  const d1 = computeSyncDiff([match], snapshot)
  const d2 = computeSyncDiff([match], snapshot)
  assert.equal(d1.inputHash, d2.inputHash)
  assert.equal(d1.outputHash, d2.outputHash)
  assert.equal(d1.changes.length, d2.changes.length)

  // After the change is applied, re-computing against the proposed fixtures is a no-op.
  const d3 = computeSyncDiff([match], { ...snapshot, fixtures: d1.proposedFixtures })
  assert.equal(d3.changes.length, 0)
})

test("FINISHED from the API writes the final score and marks NEW_FINISHED", () => {
  const fixture = makeFixture({ providerFixtureId: 1, status: "LIVE" })
  const match = makeMatch({ id: 1, status: "FINISHED", score: finishedScore(3, 0, "HOME_TEAM") })
  const diff = computeSyncDiff([match], makeSnapshot([fixture]))
  assert.equal(diff.ok, true)
  const change = diff.changes[0]
  assert.ok(change.changeCodes.includes("NEW_FINISHED"))
  assert.ok(change.changeCodes.includes("SCORE_SET"))
  assert.deepEqual(change.newScore, { home: 3, away: 0 })
  const proposed = diff.proposedFixtures[0]
  assert.equal(proposed.status, "FINISHED")
  assert.equal(proposed.fulltime_home_score, 3)
  assert.equal(proposed.fulltime_away_score, 0)
  assert.equal(proposed.winner_team_id, "team-1")
})

test("IN_PLAY does not write a final score and maps to LIVE", () => {
  const fixture = makeFixture({ providerFixtureId: 1 })
  const match = makeMatch({
    id: 1,
    status: "IN_PLAY",
    score: { winner: null, duration: "REGULAR", fullTime: { home: 1, away: 0 }, halfTime: { home: 0, away: 0 } },
  })
  const diff = computeSyncDiff([match], makeSnapshot([fixture]))
  assert.equal(diff.ok, true)
  const change = diff.changes[0]
  assert.equal(change.newStatus, "LIVE")
  assert.ok(!change.changeCodes.includes("NEW_FINISHED"))
  assert.ok(!change.changeCodes.includes("SCORE_SET"))
  assert.equal(diff.proposedFixtures[0].fulltime_home_score, null)
  assert.equal(diff.proposedFixtures[0].fulltime_away_score, null)
})

test("postponement maps to POSTPONED with no score", () => {
  const fixture = makeFixture({ providerFixtureId: 1 })
  const match = makeMatch({ id: 1, status: "POSTPONED" })
  const diff = computeSyncDiff([match], makeSnapshot([fixture]))
  assert.equal(diff.ok, true)
  const change = diff.changes[0]
  assert.equal(change.newStatus, "POSTPONED")
  assert.ok(change.changeCodes.includes("POSTPONED"))
  assert.equal(diff.proposedFixtures[0].fulltime_home_score, null)
})

test("an official kickoff reschedule is recorded as KICKOFF_CHANGED", () => {
  const fixture = makeFixture({ providerFixtureId: 1, kickoff_at: "2026-08-21T19:00:00Z" })
  const match = makeMatch({ id: 1, utcDate: "2026-08-22T14:00:00Z" })
  const diff = computeSyncDiff([match], makeSnapshot([fixture]))
  assert.equal(diff.ok, true)
  const change = diff.changes[0]
  assert.ok(change.changeCodes.includes("KICKOFF_CHANGED"))
  assert.equal(change.newKickoff, "2026-08-22T14:00:00Z")
})

test("an unknown API status is rejected with UNKNOWN_STATUS", () => {
  const fixture = makeFixture({ providerFixtureId: 1 })
  const match = makeMatch({ id: 1, status: "WEIRD_STATE" })
  const diff = computeSyncDiff([match], makeSnapshot([fixture]))
  assert.equal(diff.ok, false)
  assert.ok(diff.hardFailures.some((e) => e.code === UNKNOWN_STATUS))
})

test("a conflicting FINISHED score requires manual confirmation (blocks apply)", () => {
  const fixture = makeFixture({
    providerFixtureId: 1,
    status: "FINISHED",
    fulltime_home_score: 2,
    fulltime_away_score: 1,
    home_score: 2,
    away_score: 1,
  })
  const match = makeMatch({ id: 1, status: "FINISHED", score: finishedScore(3, 1, "HOME_TEAM") })
  const diff = computeSyncDiff([match], makeSnapshot([fixture]))
  assert.equal(diff.ok, true)
  assert.equal(diff.safeToApply, false)
  assert.ok(diff.corrections.some((e) => e.code === FINISHED_SCORE_CORRECTION_REQUIRED))
})

// --- direct-to-FINISHED (scheduled polling windows) --------------------------

test("TIMED -> FINISHED with a complete, coherent score is allowed", () => {
  const fixture = makeFixture({ providerFixtureId: 1, status: "TIMED" })
  const match = makeMatch({
    id: 1,
    status: "FINISHED",
    score: finishedScore(2, 1, "HOME_TEAM"),
    lastUpdated: "2026-09-21T00:00:00Z",
  })
  const diff = computeSyncDiff([match], makeSnapshot([fixture]))
  assert.equal(diff.ok, true)
  assert.equal(diff.safeToApply, true)
  const change = diff.changes[0]
  assert.ok(change.changeCodes.includes("NEW_FINISHED"))
  assert.ok(change.changeCodes.includes("SCORE_SET"))
  assert.deepEqual(change.newScore, { home: 2, away: 1 })
  assert.equal(diff.proposedFixtures[0].status, "FINISHED")
  assert.equal(diff.proposedFixtures[0].winner_team_id, "team-1")
})

test("SCHEDULED -> FINISHED with a complete, coherent score (draw) is allowed", () => {
  const fixture = makeFixture({ providerFixtureId: 1, status: "SCHEDULED" })
  const match = makeMatch({
    id: 1,
    status: "FINISHED",
    score: finishedScore(0, 0, "DRAW"),
    lastUpdated: "2026-09-21T00:00:00Z",
  })
  const diff = computeSyncDiff([match], makeSnapshot([fixture]))
  assert.equal(diff.ok, true)
  assert.equal(diff.safeToApply, true)
  assert.equal(diff.proposedFixtures[0].status, "FINISHED")
  assert.equal(diff.proposedFixtures[0].winner_team_id, null)
})

test("TIMED -> FINISHED with a missing score is rejected", () => {
  const fixture = makeFixture({ providerFixtureId: 1, status: "TIMED" })
  const match = makeMatch({
    id: 1,
    status: "FINISHED",
    score: { winner: null, duration: "REGULAR", fullTime: { home: null, away: 1 }, halfTime: { home: 0, away: 0 } },
  })
  const diff = computeSyncDiff([match], makeSnapshot([fixture]))
  assert.equal(diff.ok, false)
  assert.ok(diff.hardFailures.some((e) => e.code === INVALID_SCORE))
})

test("TIMED -> FINISHED with a winner inconsistent with the score is rejected", () => {
  const fixture = makeFixture({ providerFixtureId: 1, status: "TIMED" })
  const match = makeMatch({
    id: 1,
    status: "FINISHED",
    score: finishedScore(2, 1, "AWAY_TEAM"),
    lastUpdated: "2026-09-21T00:00:00Z",
  })
  const diff = computeSyncDiff([match], makeSnapshot([fixture]))
  assert.equal(diff.ok, false)
  assert.ok(diff.hardFailures.some((e) => e.code === WINNER_SCORE_MISMATCH))
})

test("TIMED -> FINISHED with an invalid lastUpdated is rejected", () => {
  const fixture = makeFixture({ providerFixtureId: 1, status: "TIMED" })
  const match = makeMatch({
    id: 1,
    status: "FINISHED",
    score: finishedScore(2, 1, "HOME_TEAM"),
    lastUpdated: "not-a-date",
  })
  const diff = computeSyncDiff([match], makeSnapshot([fixture]))
  assert.equal(diff.ok, false)
  assert.ok(diff.hardFailures.some((e) => e.code === INVALID_LAST_UPDATED))
})

test("FINISHED -> TIMED is rejected as a regression", () => {
  const fixture = makeFixture({
    providerFixtureId: 1,
    status: "FINISHED",
    fulltime_home_score: 2,
    fulltime_away_score: 1,
    home_score: 2,
    away_score: 1,
    winner_team_id: "team-1",
  })
  const match = makeMatch({ id: 1, status: "TIMED" })
  const diff = computeSyncDiff([match], makeSnapshot([fixture]))
  assert.equal(diff.ok, false)
  assert.ok(diff.hardFailures.some((e) => e.code === FINISHED_REGRESSION))
})

test("a FINISHED score correction is not masked by the new direct-to-FINISHED guards", () => {
  const fixture = makeFixture({
    providerFixtureId: 1,
    status: "FINISHED",
    fulltime_home_score: 2,
    fulltime_away_score: 1,
    home_score: 2,
    away_score: 1,
    winner_team_id: "team-1",
  })
  const match = makeMatch({
    id: 1,
    status: "FINISHED",
    score: finishedScore(3, 1, "HOME_TEAM"),
    lastUpdated: "2026-09-21T00:00:00Z",
  })
  const diff = computeSyncDiff([match], makeSnapshot([fixture]))
  assert.equal(diff.ok, true)
  assert.equal(diff.safeToApply, false)
  assert.ok(diff.corrections.some((e) => e.code === FINISHED_SCORE_CORRECTION_REQUIRED))
})

test("a reduced match count is rejected with MATCH_COUNT_MISMATCH", () => {
  const fixtures = [
    makeFixture({ providerFixtureId: 1 }),
    makeFixture({ providerFixtureId: 2 }),
    makeFixture({ providerFixtureId: 3 }),
  ]
  const matches = [makeMatch({ id: 1 }), makeMatch({ id: 2 })]
  const diff = computeSyncDiff(matches, makeSnapshot(fixtures))
  assert.equal(diff.ok, false)
  assert.ok(diff.hardFailures.some((e) => e.code === MATCH_COUNT_MISMATCH))
})

test("a non-Premier-League fixture mixed in is rejected", () => {
  const pl = makeFixture({ providerFixtureId: 1 })
  const cl = makeFixture({ providerFixtureId: 999, competition_id: "champions-league-id" })
  const matches = [makeMatch({ id: 1 })]
  const diff = computeSyncDiff(matches, makeSnapshot([pl, cl]))
  assert.equal(diff.ok, false)
  assert.ok(diff.hardFailures.some((e) => e.code === NON_PL_COMPETITION))
})

test("applySnapshot is importable and loadLocalSnapshot round-trips a written snapshot", () => {
  // Sanity: the temp-dir write helper produces a snapshot that reloads cleanly.
  const root = writeSnapshotToTemp(makeSnapshot([makeFixture({ providerFixtureId: 1 })]))
  const loaded = loadLocalSnapshot(root)
  assert.equal(loaded.fixtures.length, 1)
  assert.equal(loaded.competitions[0].slug, "premier-league")
  assert.ok(existsSync(join(root, "data", "football", "fixtures.json")))
})
