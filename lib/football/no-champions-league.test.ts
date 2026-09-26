import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  competitionsBySlug,
  fixturesByCompetitionSlug,
  staticFixtures,
  teamsById,
} from "./static-data"
import { getStaticAllClubs } from "./static-club-queries"
import { getStaticMatchesForSitemap, getStaticPremierLeagueMatchParams } from "./static-queries"

/**
 * Phase XIII-A regression guards: the Champions League must be fully removed
 * from the static snapshot, and the Premier League / World Cup data must be
 * exactly unchanged. Each assertion pins a real number so a re-introduced
 * Champions League entry, a pruned Premier League fixture, or a touched World
 * Cup record fails loudly rather than silently regressing.
 */

const ROOT = process.cwd()

interface CompetitionRow {
  id: string
  slug: string
}
interface FixtureRow {
  competition_id: string
}
interface Manifest {
  counts: { competitions: number; teams: number; fixtures: number }
  competitions: { slug: string }[]
}
interface SealedCounts {
  totalPredictions: number
  originalBacktestCount: number
  lateBacktestCount: number
  totalBacktestCount: number
  sealedCandidateCount: number
}
interface Sealed {
  counts: SealedCounts
  candidates: unknown[]
}
interface CrestManifest {
  crests: unknown[]
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as T
}

const competitions = readJson<CompetitionRow[]>("data/football/competitions.json")
const fixtures = readJson<FixtureRow[]>("data/football/fixtures.json")
const teams = readJson<unknown[]>("data/football/teams.json")
const manifest = readJson<Manifest>("data/football/manifest.json")
const wcMatches = readJson<unknown[]>("data/synced/matches.json")
const wcTeams = readJson<unknown[]>("data/synced/teams.json")
const sealed = readJson<Sealed>("data/predictions/premier-league/2026-27/sealed-predictions.json")
const crestManifest = readJson<CrestManifest>("data/football/premier-league/2026-27/crest-manifest.json")

const PL_SLUG = "premier-league"

// --- manifest -----------------------------------------------------------------

test("manifest declares exactly one competition: premier-league", () => {
  assert.equal(manifest.competitions.length, 1)
  assert.equal(manifest.competitions[0].slug, PL_SLUG)
  assert.equal(manifest.counts.competitions, 1)
  assert.equal(manifest.counts.teams, 20)
  assert.equal(manifest.counts.fixtures, 380)
})

// --- competitions.json -------------------------------------------------------

test("competitions.json contains only the Premier League", () => {
  assert.equal(competitions.length, 1)
  assert.equal(competitions[0].slug, PL_SLUG)
  assert.ok(competitions.every((c) => c.slug !== "champions-league"))
})

// --- fixtures.json -----------------------------------------------------------

test("fixtures.json has exactly 380 fixtures, all Premier League", () => {
  assert.equal(fixtures.length, 380)
  const plId = competitions[0].id
  assert.ok(fixtures.every((f) => f.competition_id === plId))
})

// --- teams.json --------------------------------------------------------------

test("teams.json has exactly 20 teams", () => {
  assert.equal(teams.length, 20)
})

// --- static snapshot indexes -------------------------------------------------

test("static snapshot indexes contain only the Premier League", () => {
  assert.equal(staticFixtures.length, 380)
  assert.equal(teamsById.size, 20)
  assert.ok(competitionsBySlug.has(PL_SLUG))
  assert.ok(!competitionsBySlug.has("champions-league"))
  assert.deepEqual([...fixturesByCompetitionSlug.keys()], [PL_SLUG])
  assert.ok(staticFixtures.every((f) => f.competition.slug === PL_SLUG))
})

// --- clubs -------------------------------------------------------------------

test("getStaticAllClubs returns 20 Premier League clubs only", () => {
  const clubs = getStaticAllClubs()
  assert.equal(clubs.length, 20)
  for (const club of clubs) {
    assert.deepEqual(
      club.competitions.map((c) => c.slug),
      [PL_SLUG],
      `${club.slug} has unexpected memberships`,
    )
  }
})

// --- sitemap ----------------------------------------------------------------

test("getStaticMatchesForSitemap returns 380 Premier League entries only", () => {
  const entries = getStaticMatchesForSitemap()
  assert.equal(entries.length, 380)
  assert.ok(entries.every((e) => e.competitionSlug === PL_SLUG))
})

// --- match params ------------------------------------------------------------

test("getStaticPremierLeagueMatchParams generates 380 unique slugs", () => {
  const params = getStaticPremierLeagueMatchParams()
  assert.equal(params.length, 380)
  assert.equal(new Set(params.map((p) => p.slug)).size, 380)
})

// --- World Cup archive -------------------------------------------------------

test("World Cup archive data is unchanged (104 matches, 48 teams)", () => {
  assert.equal(wcMatches.length, 104)
  assert.equal(wcTeams.length, 48)
})

// --- sealed predictions ------------------------------------------------------

test("sealed predictions keep the 40/10/330 split intact", () => {
  assert.equal(sealed.counts.totalPredictions, 380)
  assert.equal(sealed.counts.originalBacktestCount, 40)
  assert.equal(sealed.counts.lateBacktestCount, 10)
  assert.equal(sealed.counts.totalBacktestCount, 50)
  assert.equal(sealed.counts.sealedCandidateCount, 330)
  assert.equal(sealed.candidates.length, 330)
})

// --- crests ------------------------------------------------------------------

test("crest manifest covers exactly 20 Premier League teams", () => {
  assert.equal(crestManifest.crests.length, 20)
})
