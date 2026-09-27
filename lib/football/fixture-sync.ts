/**
 * In-season Premier League fixture sync engine.
 *
 * Turns a validated football-data.org `Match[]` into a *safe* diff against the
 * committed static snapshot (`data/football/*.json`) and, on explicit `--apply`,
 * atomically writes the updated `fixtures.json` + `manifest.json`.
 *
 * Design invariants (see docs/premier-league-static-refresh-runbook.md):
 *
 *   - Match identity is the stable `provider_fixture_id` only — never array
 *     position, team-name string, kickoff ordering or slug guessing.
 *   - Only result-related fields may change (status, scores, winner, kickoff on
 *     an official reschedule, `source_updated_at`, the local cutoff). Identity
 *     fields (id, provider ids, competition/team ids, matchweek/stage/round) are
 *     immutable.
 *   - A score is only ever written when the API reports FINISHED/AWARDED.
 *     IN_PLAY/PAUSED are never treated as final.
 *   - A FINISHED score that differs from the committed one is NOT auto-overridden;
 *     it is reported as `FINISHED_SCORE_CORRECTION_REQUIRED` and blocks apply.
 *
 * The diff computation is pure (no I/O); only `loadLocalSnapshot` and
 * `applySnapshot` touch the filesystem, so the engine is unit-testable offline.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { hashObject } from "../predictions/prediction-lock"
import type { Competition, Fixture, FixtureStatus, Team } from "../supabase/types"
import type { Match } from "../football-data/types"
import { mapFixtureStatus } from "./status-map"
import type { StaticConfig } from "./static-config"
import type { StaticManifest } from "./static-types"
import { transactionalWrite } from "./transactional-write"

// --- error codes -------------------------------------------------------------

export const MATCH_COUNT_MISMATCH = "MATCH_COUNT_MISMATCH"
export const PROVIDER_ID_SET_MISMATCH = "PROVIDER_ID_SET_MISMATCH"
export const UNKNOWN_MATCH = "UNKNOWN_MATCH"
export const MISSING_MATCH = "MISSING_MATCH"
export const TEAM_IDENTITY_MISMATCH = "TEAM_IDENTITY_MISMATCH"
export const NON_PL_COMPETITION = "NON_PL_COMPETITION"
export const DUPLICATE_MATCH = "DUPLICATE_MATCH"
export const UNKNOWN_STATUS = "UNKNOWN_STATUS"
export const INVALID_TRANSITION = "INVALID_TRANSITION"
export const FINISHED_REGRESSION = "FINISHED_REGRESSION"
export const FINISHED_SCORE_CORRECTION_REQUIRED = "FINISHED_SCORE_CORRECTION_REQUIRED"
export const KICKOFF_CHANGE_ON_FINISHED = "KICKOFF_CHANGE_ON_FINISHED"
export const INVALID_SCORE = "INVALID_SCORE"
export const INVALID_MATCHDAY = "INVALID_MATCHDAY"
export const WINNER_SCORE_MISMATCH = "WINNER_SCORE_MISMATCH"
export const INVALID_LAST_UPDATED = "INVALID_LAST_UPDATED"
export const EXISTING_SCORE_CONFLICT = "EXISTING_SCORE_CONFLICT"

// --- change codes ------------------------------------------------------------

export type ChangeCode =
  | "STATUS_CHANGED"
  | "NEW_FINISHED"
  | "SCORE_SET"
  | "KICKOFF_CHANGED"
  | "POSTPONED"
  | "CANCELLED"
  | "SUSPENDED"
  | "FINISHED_SCORE_CORRECTION"

// --- shapes ------------------------------------------------------------------

export interface LocalSnapshot {
  competitions: Competition[]
  teams: Team[]
  fixtures: Fixture[]
  manifest: StaticManifest
}

export interface SyncError {
  code: string
  matchId: string | null
  message: string
}

export interface ScoreLine {
  home: number | null
  away: number | null
}

export interface FixtureChange {
  providerFixtureId: number
  matchId: string
  slug: string
  homeSlug: string
  awaySlug: string
  oldStatus: FixtureStatus
  newStatus: FixtureStatus
  oldKickoff: string
  newKickoff: string
  oldScore: ScoreLine
  newScore: ScoreLine
  providerLastUpdated: string | null
  changeCodes: ChangeCode[]
}

export interface SyncCounts {
  apiMatches: number
  localMatches: number
  unchanged: number
  statusChanges: number
  newlyFinished: number
  kickoffChanges: number
  scoreChanges: number
  postponedOrCancelled: number
  unknownMatches: number
  identityConflicts: number
}

export interface SyncDiff {
  /** No hard failures: identity + validation + transition all clean. */
  ok: boolean
  /** ok AND no `FINISHED_SCORE_CORRECTION_REQUIRED` awaiting manual confirm. */
  safeToApply: boolean
  hardFailures: SyncError[]
  corrections: SyncError[]
  changes: FixtureChange[]
  counts: SyncCounts
  inputHash: string
  outputHash: string
  sourceLastUpdatedAt: string | null
  config: StaticConfig
  /** The proposed fixtures (changes applied), for `buildProposedManifest` + apply. */
  proposedFixtures: Fixture[]
}

// --- state machine -----------------------------------------------------------

/** Allowed internal status transitions. FINISHED and CANCELLED are terminal. */
const ALLOWED_TRANSITIONS: ReadonlyArray<readonly [FixtureStatus, FixtureStatus]> = [
  ["SCHEDULED", "TIMED"],
  ["SCHEDULED", "POSTPONED"],
  ["SCHEDULED", "LIVE"],
  ["SCHEDULED", "SUSPENDED"],
  ["SCHEDULED", "CANCELLED"],
  // A scheduled/timed match whose final whistle falls between two polling
  // windows jumps straight to FINISHED — the sync never observes LIVE in that
  // case. The direct-to-FINISHED guard below still demands a complete, coherent
  // final result before it is accepted.
  ["SCHEDULED", "FINISHED"],
  ["TIMED", "FINISHED"],
  ["TIMED", "POSTPONED"],
  ["TIMED", "LIVE"],
  ["TIMED", "SUSPENDED"],
  ["TIMED", "CANCELLED"],
  ["LIVE", "HALFTIME"],
  ["LIVE", "FINISHED"],
  ["LIVE", "SUSPENDED"],
  ["LIVE", "CANCELLED"],
  ["HALFTIME", "LIVE"],
  ["HALFTIME", "FINISHED"],
  ["HALFTIME", "SUSPENDED"],
  ["HALFTIME", "CANCELLED"],
  ["POSTPONED", "TIMED"],
  ["POSTPONED", "CANCELLED"],
  ["SUSPENDED", "LIVE"],
  ["SUSPENDED", "HALFTIME"],
  ["SUSPENDED", "FINISHED"],
  ["SUSPENDED", "POSTPONED"],
  ["SUSPENDED", "CANCELLED"],
]

const TRANSITION_SET = new Set(ALLOWED_TRANSITIONS.map(([a, b]) => `${a}>${b}`))

const NOT_STARTED: ReadonlySet<FixtureStatus> = new Set(["SCHEDULED", "TIMED"])

function isTransitionAllowed(from: FixtureStatus, to: FixtureStatus): boolean {
  if (from === to) return true
  if (from === "FINISHED") return false // terminal: no regression out of FINISHED
  if (from === "CANCELLED") return false // terminal
  return TRANSITION_SET.has(`${from}>${to}`)
}

// --- I/O ---------------------------------------------------------------------

export function loadLocalSnapshot(root: string = process.cwd()): LocalSnapshot {
  const dir = join(root, "data", "football")
  return {
    competitions: JSON.parse(readFileSync(join(dir, "competitions.json"), "utf8")) as Competition[],
    teams: JSON.parse(readFileSync(join(dir, "teams.json"), "utf8")) as Team[],
    fixtures: JSON.parse(readFileSync(join(dir, "fixtures.json"), "utf8")) as Fixture[],
    manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as StaticManifest,
  }
}

// --- diff --------------------------------------------------------------------

function scoreLine(home: number | null, away: number | null): ScoreLine {
  return { home, away }
}

function sameScore(a: ScoreLine, b: ScoreLine): boolean {
  return a.home === b.home && a.away === b.away
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0
}

/** The winner a given final score implies, or null when the score is incomplete. */
function winnerForScore(
  home: number | null,
  away: number | null,
): "HOME_TEAM" | "AWAY_TEAM" | "DRAW" | null {
  if (home === null || away === null) return null
  if (home > away) return "HOME_TEAM"
  if (home < away) return "AWAY_TEAM"
  return "DRAW"
}

/** Largest credible `lastUpdated` across the API matches, or null if none parse. */
function maxLastUpdated(matches: Match[]): string | null {
  let max: number | null = null
  let maxIso: string | null = null
  for (const m of matches) {
    if (typeof m.lastUpdated !== "string" || m.lastUpdated === "") continue
    const t = Date.parse(m.lastUpdated)
    if (Number.isNaN(t)) continue
    if (max === null || t > max) {
      max = t
      maxIso = m.lastUpdated
    }
  }
  return maxIso
}

/**
 * Compute the sync diff between a validated API payload and the local snapshot.
 * Pure and deterministic: reads no files and writes nothing, and injects no
 * wall-clock time. `appliedAt` is optional and only stamped onto changed
 * fixtures' `updated_at` by the apply path — a dry-run leaves it null so the
 * output hash is stable across runs.
 */
export function computeSyncDiff(apiMatches: Match[], snapshot: LocalSnapshot, appliedAt: string | null = null): SyncDiff {
  const config = loadStaticConfigFor(snapshot.competitions)
  const hardFailures: SyncError[] = []
  const corrections: SyncError[] = []

  const plFixtures = snapshot.fixtures.filter((f) => f.competition_id === config.competitionId)
  const nonPl = snapshot.fixtures.filter((f) => f.competition_id !== config.competitionId)
  if (nonPl.length > 0) {
    hardFailures.push({
      code: NON_PL_COMPETITION,
      matchId: nonPl[0].id,
      message: `${nonPl.length} fixture(s) reference a non-Premier-League competition`,
    })
  }

  if (apiMatches.length !== plFixtures.length) {
    hardFailures.push({
      code: MATCH_COUNT_MISMATCH,
      matchId: null,
      message: `API ${apiMatches.length} vs local ${plFixtures.length} PL fixtures`,
    })
  }

  const fixturesByProviderId = new Map<number, Fixture>()
  for (const f of plFixtures) {
    if (fixturesByProviderId.has(f.provider_fixture_id)) {
      hardFailures.push({
        code: DUPLICATE_MATCH,
        matchId: f.id,
        message: `duplicate provider_fixture_id ${f.provider_fixture_id}`,
      })
    }
    fixturesByProviderId.set(f.provider_fixture_id, f)
  }

  const teamsById = new Map(snapshot.teams.map((t) => [t.id, t]))
  const teamsByProviderTeamId = new Map(snapshot.teams.map((t) => [t.provider_team_id, t]))

  const apiProviderIds = new Set<number>()
  for (const m of apiMatches) {
    if (apiProviderIds.has(m.id)) {
      hardFailures.push({ code: DUPLICATE_MATCH, matchId: null, message: `duplicate API match id ${m.id}` })
    }
    apiProviderIds.add(m.id)

    if (!fixturesByProviderId.has(m.id)) {
      hardFailures.push({ code: UNKNOWN_MATCH, matchId: null, message: `API match ${m.id} has no local fixture` })
    }
  }
  for (const f of plFixtures) {
    if (!apiProviderIds.has(f.provider_fixture_id)) {
      hardFailures.push({
        code: MISSING_MATCH,
        matchId: f.id,
        message: `local fixture ${f.id} (${f.provider_fixture_id}) is absent from the API`,
      })
    }
  }

  // Per-match identity + transition/score reconciliation.
  const changes: FixtureChange[] = []
  const apiById = new Map(apiMatches.map((m) => [m.id, m]))

  for (const f of [...plFixtures].sort((a, b) => a.provider_fixture_id - b.provider_fixture_id)) {
    const m = apiById.get(f.provider_fixture_id)
    if (!m) continue // already reported as MISSING_MATCH

    // --- team identity ---
    const homeTeam = teamsByProviderTeamId.get(m.homeTeam.id)
    const awayTeam = teamsByProviderTeamId.get(m.awayTeam.id)
    if (!homeTeam || homeTeam.id !== f.home_team_id) {
      hardFailures.push({
        code: TEAM_IDENTITY_MISMATCH,
        matchId: f.id,
        message: `API home team ${m.homeTeam.id} resolves to ${homeTeam?.id ?? "?"}, expected ${f.home_team_id}`,
      })
    }
    if (!awayTeam || awayTeam.id !== f.away_team_id) {
      hardFailures.push({
        code: TEAM_IDENTITY_MISMATCH,
        matchId: f.id,
        message: `API away team ${m.awayTeam.id} resolves to ${awayTeam?.id ?? "?"}, expected ${f.away_team_id}`,
      })
    }

    // --- matchday range ---
    if (m.matchday != null && (!Number.isInteger(m.matchday) || m.matchday < 1 || m.matchday > 38)) {
      hardFailures.push({
        code: INVALID_MATCHDAY,
        matchId: f.id,
        message: `match ${m.id} has out-of-range matchday ${m.matchday}`,
      })
    }

    const statusResult = mapFixtureStatus(m.status)
    if (!statusResult.recognized || statusResult.status === null) {
      hardFailures.push({ code: UNKNOWN_STATUS, matchId: f.id, message: `match ${m.id} status ${m.status} unrecognized` })
      continue
    }
    const newStatus = statusResult.status
    const oldStatus = f.status

    if (!isTransitionAllowed(oldStatus, newStatus)) {
      if (oldStatus === "FINISHED" && newStatus !== "FINISHED") {
        hardFailures.push({
          code: FINISHED_REGRESSION,
          matchId: f.id,
          message: `match ${m.id} regressed from FINISHED to ${newStatus}`,
        })
      } else {
        hardFailures.push({
          code: INVALID_TRANSITION,
          matchId: f.id,
          message: `match ${m.id} illegal transition ${oldStatus} -> ${newStatus}`,
        })
      }
      continue
    }

    const isFinal = newStatus === "FINISHED"
    const finalHome = isFinal ? m.score?.fullTime?.home ?? null : null
    const finalAway = isFinal ? m.score?.fullTime?.away ?? null : null
    const halfHome = isFinal ? m.score?.halfTime?.home ?? null : null
    const halfAway = isFinal ? m.score?.halfTime?.away ?? null : null

    if (isFinal && (!isNonNegativeInt(finalHome) || !isNonNegativeInt(finalAway))) {
      hardFailures.push({
        code: INVALID_SCORE,
        matchId: f.id,
        message: `match ${m.id} FINISHED with non-integer/negative full-time score`,
      })
      continue
    }

    // Direct-to-FINISHED (and any FINISHED) guards: a final result is only ever
    // accepted when it is complete *and* self-consistent, and never overwrites a
    // final score the local snapshot already holds.
    if (isFinal) {
      const winner = m.score?.winner ?? null
      const expectedWinner = winnerForScore(finalHome, finalAway)
      if (expectedWinner === null || winner !== expectedWinner) {
        hardFailures.push({
          code: WINNER_SCORE_MISMATCH,
          matchId: f.id,
          message: `match ${m.id} FINISHED winner ${String(winner)} inconsistent with score ${finalHome}-${finalAway}`,
        })
        continue
      }

      if (typeof m.lastUpdated !== "string" || m.lastUpdated === "" || Number.isNaN(Date.parse(m.lastUpdated))) {
        hardFailures.push({
          code: INVALID_LAST_UPDATED,
          matchId: f.id,
          message: `match ${m.id} FINISHED with invalid lastUpdated ${String(m.lastUpdated)}`,
        })
        continue
      }

      if (oldStatus !== "FINISHED" && (f.fulltime_home_score !== null || f.fulltime_away_score !== null)) {
        hardFailures.push({
          code: EXISTING_SCORE_CONFLICT,
          matchId: f.id,
          message: `match ${m.id} FINISHED but local ${oldStatus} fixture already carries a final score`,
        })
        continue
      }
    }

    const oldScore = scoreLine(f.fulltime_home_score, f.fulltime_away_score)
    const newScore = scoreLine(finalHome, finalAway)

    const kickoffChanged = Date.parse(m.utcDate) !== Date.parse(f.kickoff_at)
    if (kickoffChanged && oldStatus === "FINISHED") {
      hardFailures.push({
        code: KICKOFF_CHANGE_ON_FINISHED,
        matchId: f.id,
        message: `finished match ${m.id} kickoff changed`,
      })
      continue
    }

    // A FINISHED score that differs from the committed one is a correction:
    // never auto-override, block apply, require manual confirmation.
    if (oldStatus === "FINISHED" && newStatus === "FINISHED" && !sameScore(oldScore, newScore)) {
      corrections.push({
        code: FINISHED_SCORE_CORRECTION_REQUIRED,
        matchId: f.id,
        message: `match ${m.id} finished score ${oldScore.home}-${oldScore.away} != API ${newScore.home}-${newScore.away} (lastUpdated ${m.lastUpdated ?? "n/a"})`,
      })
      changes.push({
        providerFixtureId: m.id,
        matchId: f.id,
        slug: buildSlug(f, teamsById),
        homeSlug: teamsById.get(f.home_team_id)?.slug ?? "?",
        awaySlug: teamsById.get(f.away_team_id)?.slug ?? "?",
        oldStatus,
        newStatus,
        oldKickoff: f.kickoff_at,
        newKickoff: m.utcDate,
        oldScore,
        newScore,
        providerLastUpdated: m.lastUpdated ?? null,
        changeCodes: ["FINISHED_SCORE_CORRECTION"],
      })
      continue
    }

    // No semantic change → no change record, no timestamp churn.
    const statusChanged = oldStatus !== newStatus
    const scoreChanged = !sameScore(oldScore, newScore)
    if (!statusChanged && !scoreChanged && !kickoffChanged) {
      continue
    }

    const codes: ChangeCode[] = []
    if (statusChanged) codes.push("STATUS_CHANGED")
    if (statusChanged && newStatus === "FINISHED") codes.push("NEW_FINISHED")
    if (statusChanged && newStatus === "POSTPONED") codes.push("POSTPONED")
    if (statusChanged && newStatus === "CANCELLED") codes.push("CANCELLED")
    if (statusChanged && newStatus === "SUSPENDED") codes.push("SUSPENDED")
    if (scoreChanged) codes.push("SCORE_SET")
    if (kickoffChanged) codes.push("KICKOFF_CHANGED")

    changes.push({
      providerFixtureId: m.id,
      matchId: f.id,
      slug: buildSlug(f, teamsById),
      homeSlug: teamsById.get(f.home_team_id)?.slug ?? "?",
      awaySlug: teamsById.get(f.away_team_id)?.slug ?? "?",
      oldStatus,
      newStatus,
      oldKickoff: f.kickoff_at,
      newKickoff: m.utcDate,
      oldScore,
      newScore,
      providerLastUpdated: m.lastUpdated ?? null,
      changeCodes: codes,
    })

    // Carry half-time scores through for the proposed snapshot (unused in the
    // diff surface but required when writing a FINISHED fixture).
    void halfHome
    void halfAway
  }

  const sourceLastUpdatedAt = maxLastUpdated(apiMatches)
  const proposedFixtures = buildProposedFixtures(snapshot, config.competitionId, changes, apiById, appliedAt)
  const outputHash = hashObject(proposedFixtures)
  const inputHash = hashObject(apiMatches)

  const counts: SyncCounts = {
    apiMatches: apiMatches.length,
    localMatches: plFixtures.length,
    unchanged: plFixtures.length - changes.length,
    statusChanges: changes.filter((c) => c.changeCodes.includes("STATUS_CHANGED")).length,
    newlyFinished: changes.filter((c) => c.changeCodes.includes("NEW_FINISHED")).length,
    kickoffChanges: changes.filter((c) => c.changeCodes.includes("KICKOFF_CHANGED")).length,
    scoreChanges: changes.filter((c) => c.changeCodes.includes("SCORE_SET")).length,
    postponedOrCancelled: changes.filter((c) => c.changeCodes.includes("POSTPONED") || c.changeCodes.includes("CANCELLED")).length,
    unknownMatches: hardFailures.filter((e) => e.code === UNKNOWN_MATCH).length,
    identityConflicts: hardFailures.filter((e) => e.code !== UNKNOWN_STATUS && e.code !== INVALID_TRANSITION && e.code !== FINISHED_REGRESSION).length,
  }

  const ok = hardFailures.length === 0
  const safeToApply = ok && corrections.length === 0

  return {
    ok,
    safeToApply,
    hardFailures,
    corrections,
    changes,
    counts,
    inputHash,
    outputHash,
    sourceLastUpdatedAt,
    config,
    proposedFixtures,
  }
}

// --- proposed snapshot -------------------------------------------------------

function buildSlug(f: Fixture, teamsById: Map<string, Team>): string {
  const home = teamsById.get(f.home_team_id)?.slug ?? "home"
  const away = teamsById.get(f.away_team_id)?.slug ?? "away"
  return `${home}-vs-${away}-${f.provider_fixture_id}`
}

function loadStaticConfigFor(competitions: Competition[]): StaticConfig {
  // Reuse the committed-data derivation without re-reading the filesystem.
  const pl = competitions.find((c) => c.slug === "premier-league")
  if (!pl) throw new Error("premier-league competition not found in snapshot")
  if (typeof pl.current_season !== "number" || !Number.isInteger(pl.current_season)) {
    throw new Error("premier-league current_season missing")
  }
  const season = pl.current_season
  return {
    competitionId: pl.id,
    competitionSlug: pl.slug,
    season,
    seasonLabel: `${season}-${String((season + 1) % 100).padStart(2, "0")}`,
    providerCompetitionId: pl.provider_competition_id,
  }
}

/**
 * Apply the computed changes to a copy of the local fixtures. Only result fields
 * change; identity fields and untouched fixtures stay byte-identical.
 */
function buildProposedFixtures(
  snapshot: LocalSnapshot,
  competitionId: string,
  changes: FixtureChange[],
  apiById: Map<number, Match>,
  appliedAt: string | null,
): Fixture[] {
  const changeByProviderId = new Map(changes.map((c) => [c.providerFixtureId, c]))
  return snapshot.fixtures.map((f) => {
    if (f.competition_id !== competitionId) return f
    const change = changeByProviderId.get(f.provider_fixture_id)
    if (!change) return f

    const m = apiById.get(f.provider_fixture_id)
    const next: Fixture = { ...f }

    next.status = change.newStatus
    next.kickoff_at = change.newKickoff
    next.home_score = change.newScore.home
    next.away_score = change.newScore.away
    next.fulltime_home_score = change.newScore.home
    next.fulltime_away_score = change.newScore.away

    if (change.newStatus === "FINISHED") {
      next.halftime_home_score = m?.score?.halfTime?.home ?? null
      next.halftime_away_score = m?.score?.halfTime?.away ?? null
      const winner = m?.score?.winner ?? null
      next.winner_team_id =
        winner === "HOME_TEAM" ? f.home_team_id : winner === "AWAY_TEAM" ? f.away_team_id : null
    } else {
      next.halftime_home_score = null
      next.halftime_away_score = null
      next.winner_team_id = null
    }

    next.source_updated_at = change.providerLastUpdated ?? f.source_updated_at
    if (appliedAt !== null) next.updated_at = appliedAt

    return next
  })
}

export interface ProposedManifestInput {
  snapshot: LocalSnapshot
  fixtures: Fixture[]
  sourceLastUpdatedAt: string | null
  exportedAt: string
}

/** Rebuild `manifest.json` counts from the proposed fixtures. */
export function buildProposedManifest(input: ProposedManifestInput): StaticManifest {
  const { snapshot, fixtures, sourceLastUpdatedAt, exportedAt } = input
  const finished = fixtures.filter((f) => f.status === "FINISHED").length
  const notStarted = fixtures.filter((f) => NOT_STARTED.has(f.status)).length

  return {
    ...snapshot.manifest,
    exportedAt,
    sourceLastUpdatedAt: sourceLastUpdatedAt ?? snapshot.manifest.sourceLastUpdatedAt,
    counts: {
      competitions: snapshot.manifest.counts.competitions,
      teams: snapshot.manifest.counts.teams,
      fixtures: fixtures.length,
      finishedFixtures: finished,
      scheduledFixtures: notStarted,
    },
    competitions: snapshot.manifest.competitions.map((c) => {
      if (c.slug !== "premier-league") return c
      return {
        ...c,
        fixtures: fixtures.length,
        finishedFixtures: finished,
        upcomingFixtures: notStarted,
      }
    }),
  }
}

// --- apply -------------------------------------------------------------------

const INDENT = 2

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, INDENT)}\n`
}

/**
 * Transactionally write `fixtures.json` + `manifest.json` as one unit. The two
 * files change together or not at all: `transactionalWrite` stages them in a
 * temporary directory, validates the cross-file relationship (manifest counts
 * must agree with the fixture status distribution), backs up the originals and
 * then replaces them — rolling back every file on any failure.
 */
export function applySnapshot(fixtures: Fixture[], manifest: StaticManifest, root: string = process.cwd()): void {
  const fixturesText = stableJson(fixtures)
  const manifestText = stableJson(manifest)

  transactionalWrite({
    root,
    files: [
      { relativePath: join("data", "football", "fixtures.json"), content: fixturesText },
      { relativePath: join("data", "football", "manifest.json"), content: manifestText },
    ],
    validate: (files) => {
      const parsedFixtures = JSON.parse(files.get(join("data", "football", "fixtures.json")) ?? "[]") as Fixture[]
      const parsedManifest = JSON.parse(files.get(join("data", "football", "manifest.json")) ?? "{}") as StaticManifest
      const finished = parsedFixtures.filter((f) => f.status === "FINISHED").length
      const notStarted = parsedFixtures.filter((f) => NOT_STARTED.has(f.status)).length
      if (parsedManifest.counts.fixtures !== parsedFixtures.length) {
        throw new Error(
          `manifest counts.fixtures ${parsedManifest.counts.fixtures} != fixtures length ${parsedFixtures.length}`,
        )
      }
      if (parsedManifest.counts.finishedFixtures !== finished) {
        throw new Error(`manifest finishedFixtures ${parsedManifest.counts.finishedFixtures} != ${finished}`)
      }
      if (parsedManifest.counts.scheduledFixtures !== notStarted) {
        throw new Error(`manifest scheduledFixtures ${parsedManifest.counts.scheduledFixtures} != ${notStarted}`)
      }
    },
  })
}

// --- report ------------------------------------------------------------------

export function formatDiffReport(diff: SyncDiff): string {
  const c = diff.counts
  const lines: string[] = []
  lines.push(`API matches:            ${c.apiMatches}`)
  lines.push(`Local matches:          ${c.localMatches}`)
  lines.push(`Unchanged:              ${c.unchanged}`)
  lines.push(`Status changes:         ${c.statusChanges}`)
  lines.push(`Newly finished:         ${c.newlyFinished}`)
  lines.push(`Kickoff changes:        ${c.kickoffChanges}`)
  lines.push(`Score changes:          ${c.scoreChanges}`)
  lines.push(`Postponed/cancelled:    ${c.postponedOrCancelled}`)
  lines.push(`Unknown matches:        ${c.unknownMatches}`)
  lines.push(`Identity conflicts:     ${c.identityConflicts}`)
  lines.push(`Input hash:             ${diff.inputHash}`)
  lines.push(`Expected output hash:   ${diff.outputHash}`)
  lines.push(`sourceLastUpdatedAt:    ${diff.sourceLastUpdatedAt ?? "null"}`)
  lines.push(`Safe to apply:          ${diff.safeToApply ? "yes" : "no"}`)
  if (diff.corrections.length > 0) {
    lines.push(`Corrections required:   ${diff.corrections.length}`)
  }
  return lines.join("\n")
}

export function formatChangeReport(changes: FixtureChange[]): string {
  if (changes.length === 0) return "  (no per-match changes)"
  return changes
    .map((ch) => {
      const score = (s: ScoreLine) =>
        s.home === null || s.away === null ? "null" : `${s.home}-${s.away}`
      return (
        `  #${ch.providerFixtureId} ${ch.slug}\n` +
        `    ${ch.homeSlug} vs ${ch.awaySlug}\n` +
        `    status:    ${ch.oldStatus} -> ${ch.newStatus}\n` +
        `    kickoff:   ${ch.oldKickoff} -> ${ch.newKickoff}\n` +
        `    score:     ${score(ch.oldScore)} -> ${score(ch.newScore)}\n` +
        `    updated:   ${ch.providerLastUpdated ?? "n/a"}\n` +
        `    codes:     ${ch.changeCodes.join(", ")}`
      )
    })
    .join("\n")
}
