/**
 * Offline verification of the static football-data snapshot (`data/football/*.json`).
 *
 * This script reads ONLY local JSON — it never connects to Supabase and never
 * calls any API. It exists so the static snapshot can be re-validated in CI or
 * on any checkout without credentials.
 *
 * It fails (exit 1) on any violation and reports the real numbers it found —
 * it never fakes or pads data, and never coerces an unknown status to a known
 * one.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { Competition, Fixture, FixtureStatus, Team } from "../lib/supabase/types"
import {
  FIXTURE_STATUSES,
  FINISHED_STATUSES,
  NOT_STARTED_STATUSES,
  STATIC_SCHEMA_VERSION,
  type StaticManifest,
} from "../lib/football/static-types"

const DATA_DIR = join(process.cwd(), "data", "football")

const PREMIER_LEAGUE_SLUG = "premier-league"
const EXPECTED_PL_TEAMS = 20
const EXPECTED_PL_FIXTURES = 380

// --- error collector ---------------------------------------------------------

const errors: string[] = []
function fail(message: string): void {
  errors.push(message)
}

// --- helpers -----------------------------------------------------------------

function isFixtureStatus(value: unknown): value is FixtureStatus {
  return typeof value === "string" && (FIXTURE_STATUSES as readonly string[]).includes(value)
}

function isNotStarted(status: FixtureStatus): boolean {
  return (NOT_STARTED_STATUSES as readonly string[]).includes(status)
}

function isFinished(status: FixtureStatus): boolean {
  return (FINISHED_STATUSES as readonly string[]).includes(status)
}

function readJsonArray(file: string): unknown[] {
  const path = join(DATA_DIR, file)
  if (!existsSync(path)) {
    fail(`missing file ${file}`)
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"))
  } catch (err) {
    fail(`failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  if (!Array.isArray(parsed)) {
    fail(`${file} root is not an array`)
    return []
  }
  return parsed
}

function readJsonObject(file: string): Record<string, unknown> | null {
  const path = join(DATA_DIR, file)
  if (!existsSync(path)) {
    fail(`missing file ${file}`)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"))
  } catch (err) {
    fail(`failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`${file} root is not an object`)
    return null
  }
  return parsed as Record<string, unknown>
}

// --- main ---------------------------------------------------------------------

function main(): void {
  const competitions = readJsonArray("competitions.json") as unknown as Competition[]
  const teams = readJsonArray("teams.json") as unknown as Team[]
  const fixtures = readJsonArray("fixtures.json") as unknown as Fixture[]
  const manifestRaw = readJsonObject("manifest.json")
  const manifest = manifestRaw as unknown as StaticManifest

  // --- file-level ------------------------------------------------------------

  if (competitions.length === 0) fail("competitions.json is an empty array")
  if (teams.length === 0) fail("teams.json is an empty array")
  if (fixtures.length === 0) fail("fixtures.json is an empty array")

  if (manifestRaw !== null) {
    if (typeof manifest.schemaVersion !== "number") fail("manifest.schemaVersion is missing")
    else if (manifest.schemaVersion !== STATIC_SCHEMA_VERSION) {
      fail(`manifest.schemaVersion ${manifest.schemaVersion} != ${STATIC_SCHEMA_VERSION}`)
    }
    if (typeof manifest.provider !== "string") fail("manifest.provider is missing")
    if (typeof manifest.exportedAt !== "string" || Number.isNaN(Date.parse(manifest.exportedAt))) {
      fail("manifest.exportedAt is not a valid ISO timestamp")
    }
    if (!manifest.counts || typeof manifest.counts !== "object") fail("manifest.counts is missing")
    if (!Array.isArray(manifest.competitions)) fail("manifest.competitions is not an array")
  }

  // --- uniqueness ------------------------------------------------------------

  const competitionIds = new Set<string>()
  const competitionSlugs = new Set<string>()
  const competitionKeys = new Set<string>()
  for (const c of competitions) {
    if (!c.id) fail("competition with empty id")
    else if (competitionIds.has(c.id)) fail(`duplicate competition id ${c.id}`)
    else competitionIds.add(c.id)

    if (!c.slug) fail(`competition ${c.id} with empty slug`)
    else if (competitionSlugs.has(c.slug)) fail(`duplicate competition slug ${c.slug}`)
    else competitionSlugs.add(c.slug)

    const key = `${c.provider}/${c.provider_competition_id}`
    if (competitionKeys.has(key)) fail(`duplicate competition provider id ${key}`)
    else competitionKeys.add(key)
  }

  const teamIds = new Set<string>()
  const teamSlugs = new Set<string>()
  const teamKeys = new Set<string>()
  for (const t of teams) {
    if (!t.id) fail("team with empty id")
    else if (teamIds.has(t.id)) fail(`duplicate team id ${t.id}`)
    else teamIds.add(t.id)

    if (!t.slug) fail(`team ${t.id} with empty slug`)
    else if (teamSlugs.has(t.slug)) fail(`duplicate team slug ${t.slug}`)
    else teamSlugs.add(t.slug)

    const key = `${t.provider}/${t.provider_team_id}`
    if (teamKeys.has(key)) fail(`duplicate team provider id ${key}`)
    else teamKeys.add(key)
  }

  const fixtureIds = new Set<string>()
  const fixtureKeys = new Set<string>()
  const statusCounts = new Map<string, number>()
  for (const f of fixtures) {
    if (!f.id) fail("fixture with empty id")
    else if (fixtureIds.has(f.id)) fail(`duplicate fixture id ${f.id}`)
    else fixtureIds.add(f.id)

    const key = `${f.provider}/${f.provider_fixture_id}`
    if (fixtureKeys.has(key)) fail(`duplicate fixture provider id ${key}`)
    else fixtureKeys.add(key)

    // --- referential integrity ---
    if (!competitionIds.has(f.competition_id)) {
      fail(`fixture ${f.id} references unknown competition ${f.competition_id}`)
    }
    if (!teamIds.has(f.home_team_id)) fail(`fixture ${f.id} references unknown home team ${f.home_team_id}`)
    if (!teamIds.has(f.away_team_id)) fail(`fixture ${f.id} references unknown away team ${f.away_team_id}`)
    if (f.home_team_id && f.home_team_id === f.away_team_id) {
      fail(`fixture ${f.id} has home_team_id === away_team_id`)
    }
    if (f.winner_team_id != null && f.winner_team_id !== f.home_team_id && f.winner_team_id !== f.away_team_id) {
      fail(`fixture ${f.id} winner ${f.winner_team_id} is neither home nor away`)
    }

    // --- status ---
    if (f.status == null) fail(`fixture ${f.id} has null status`)
    else if (!isFixtureStatus(f.status)) fail(`fixture ${f.id} has unknown status ${String(f.status)}`)
    else statusCounts.set(f.status, (statusCounts.get(f.status) ?? 0) + 1)

    // --- scores ---
    for (const [label, score] of [
      ["home_score", f.home_score],
      ["away_score", f.away_score],
      ["halftime_home_score", f.halftime_home_score],
      ["halftime_away_score", f.halftime_away_score],
      ["fulltime_home_score", f.fulltime_home_score],
      ["fulltime_away_score", f.fulltime_away_score],
    ] as const) {
      if (score != null && score < 0) fail(`fixture ${f.id} has negative ${label}`)
    }
    if (f.status != null && isNotStarted(f.status)) {
      const anyScore =
        f.home_score != null ||
        f.away_score != null ||
        f.halftime_home_score != null ||
        f.halftime_away_score != null ||
        f.fulltime_home_score != null ||
        f.fulltime_away_score != null
      if (anyScore) fail(`fixture ${f.id} is not started but carries a score`)
    }
    if (f.status != null && isFinished(f.status)) {
      if (f.home_score == null || f.away_score == null) {
        fail(`fixture ${f.id} is FINISHED but missing a full-time score`)
      }
    }

    // --- kickoff ---
    if (typeof f.kickoff_at !== "string" || f.kickoff_at === "" || Number.isNaN(Date.parse(f.kickoff_at))) {
      fail(`fixture ${f.id} has invalid kickoff_at ${String(f.kickoff_at)}`)
    }
  }

  // --- manifest consistency ---------------------------------------------------

  if (manifestRaw !== null && manifest.counts) {
    const finishedCount = fixtures.filter((f) => f.status != null && isFinished(f.status)).length
    const scheduledCount = fixtures.filter((f) => f.status != null && isNotStarted(f.status)).length

    if (manifest.counts.competitions !== competitions.length) {
      fail(`manifest counts.competitions ${manifest.counts.competitions} != ${competitions.length}`)
    }
    if (manifest.counts.teams !== teams.length) {
      fail(`manifest counts.teams ${manifest.counts.teams} != ${teams.length}`)
    }
    if (manifest.counts.fixtures !== fixtures.length) {
      fail(`manifest counts.fixtures ${manifest.counts.fixtures} != ${fixtures.length}`)
    }
    if (manifest.counts.finishedFixtures !== finishedCount) {
      fail(`manifest counts.finishedFixtures ${manifest.counts.finishedFixtures} != ${finishedCount}`)
    }
    if (manifest.counts.scheduledFixtures !== scheduledCount) {
      fail(`manifest counts.scheduledFixtures ${manifest.counts.scheduledFixtures} != ${scheduledCount}`)
    }

    if (Array.isArray(manifest.competitions) && manifest.competitions.length !== competitions.length) {
      fail(`manifest.competitions length ${manifest.competitions.length} != ${competitions.length}`)
    }

    const competitionBySlug = new Map(competitions.map((c) => [c.slug, c]))
    for (const entry of manifest.competitions ?? []) {
      const comp = competitionBySlug.get(entry.slug)
      if (!comp) {
        fail(`manifest references unknown competition slug ${entry.slug}`)
        continue
      }
      const compFixtures = fixtures.filter((f) => f.competition_id === comp.id)
      const teamSet = new Set<string>()
      for (const f of compFixtures) {
        teamSet.add(f.home_team_id)
        teamSet.add(f.away_team_id)
      }
      const compFinished = compFixtures.filter((f) => f.status != null && isFinished(f.status)).length
      const compUpcoming = compFixtures.filter((f) => f.status != null && isNotStarted(f.status)).length

      if (entry.fixtures !== compFixtures.length) {
        fail(`manifest ${entry.slug} fixtures ${entry.fixtures} != ${compFixtures.length}`)
      }
      if (entry.teams !== teamSet.size) {
        fail(`manifest ${entry.slug} teams ${entry.teams} != ${teamSet.size}`)
      }
      if (entry.finishedFixtures !== compFinished) {
        fail(`manifest ${entry.slug} finishedFixtures ${entry.finishedFixtures} != ${compFinished}`)
      }
      if (entry.upcomingFixtures !== compUpcoming) {
        fail(`manifest ${entry.slug} upcomingFixtures ${entry.upcomingFixtures} != ${compUpcoming}`)
      }
      if (entry.season !== comp.current_season) {
        fail(`manifest ${entry.slug} season ${entry.season} != ${comp.current_season}`)
      }
    }
  }

  // --- Premier League specific ------------------------------------------------

  const plCompetitions = competitions.filter((c) => c.slug === PREMIER_LEAGUE_SLUG)
  if (plCompetitions.length === 0) {
    fail(`competition with slug ${PREMIER_LEAGUE_SLUG} not found`)
  } else if (plCompetitions.length > 1) {
    fail(`competition with slug ${PREMIER_LEAGUE_SLUG} is not unique (${plCompetitions.length})`)
  } else {
    const pl = plCompetitions[0]
    const plFixtures = fixtures.filter((f) => f.competition_id === pl.id)
    const plTeams = new Set<string>()
    for (const f of plFixtures) {
      plTeams.add(f.home_team_id)
      plTeams.add(f.away_team_id)
    }

    for (const f of plFixtures) {
      // Fields required to build a match URL/slug and resolve both sides.
      if (!f.home_team_id) fail(`PL fixture ${f.id} missing home_team_id`)
      if (!f.away_team_id) fail(`PL fixture ${f.id} missing away_team_id`)
      if (!teamIds.has(f.home_team_id)) fail(`PL fixture ${f.id} home team ${f.home_team_id} not in teams`)
      if (!teamIds.has(f.away_team_id)) fail(`PL fixture ${f.id} away team ${f.away_team_id} not in teams`)
      if (!f.kickoff_at) fail(`PL fixture ${f.id} missing kickoff_at`)
      if (f.status == null) fail(`PL fixture ${f.id} missing status`)
      if (f.provider_fixture_id == null) fail(`PL fixture ${f.id} missing provider_fixture_id`)
    }

    if (plTeams.size !== EXPECTED_PL_TEAMS) {
      fail(
        `Premier League has ${plTeams.size} teams (expected ${EXPECTED_PL_TEAMS}); ` +
          "not padding or fetching from the API",
      )
    }
    if (plFixtures.length !== EXPECTED_PL_FIXTURES) {
      fail(
        `Premier League has ${plFixtures.length} fixtures (expected ${EXPECTED_PL_FIXTURES}); ` +
          "not padding or fetching from the API",
      )
    }

    console.log(
      `Premier League: ${plTeams.size} teams, ${plFixtures.length} fixtures ` +
        `(${plFixtures.filter((f) => f.status != null && isFinished(f.status)).length} finished)`,
    )
  }

  // --- report -----------------------------------------------------------------

  if (errors.length > 0) {
    console.error(`\nVerification FAILED with ${errors.length} error(s):`)
    for (const e of errors) console.error(`- ${e}`)
    process.exit(1)
  }

  const other = [...statusCounts.entries()]
    .filter(([s]) => !(NOT_STARTED_STATUSES as readonly string[]).includes(s) && !isFinished(s as FixtureStatus))
    .reduce((sum, [, n]) => sum + n, 0)

  console.log(
    `Verification PASSED: ${competitions.length} competitions, ${teams.length} teams, ` +
      `${fixtures.length} fixtures (${[...statusCounts.entries()].map(([s, n]) => `${s}=${n}`).join(", ")}; ` +
      `other=${other})`,
  )
}

main()
