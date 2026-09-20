/**
 * Read-only export of the football data in Supabase to local static JSON
 * (`data/football/*.json`) for the static build.
 *
 * Hard constraints (enforced by design):
 * - SELECT only: the Supabase query builder is restricted to `.select()`,
 *   `.order()` and `.range()` — never `.insert/.update/.delete/.upsert/.rpc`.
 * - Paginated (500 rows/page, ordered by primary key `id`) so the export is
 *   never truncated by a default row limit even as the tables grow.
 * - Explicit column lists (never `select("*")`).
 * - Safe write: every query runs to completion and every integrity check passes
 *   before anything is written; files are written to a temp path and atomically
 *   renamed, so a partial or invalid export never overwrites an existing valid
 *   snapshot. No other files in the target directory are touched.
 * - No secret is ever printed or written: nothing from `.env.sync` is logged.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { loadSyncEnv } from "./load-sync-env"
import { getAdminSupabase } from "../lib/supabase/admin"
import type { Competition, Fixture, Team } from "../lib/supabase/types"
import {
  FIXTURE_STATUSES,
  STATIC_SCHEMA_VERSION,
  type CompetitionManifest,
  type StaticManifest,
} from "../lib/football/static-types"

const PROVIDER = "football-data.org"
const PAGE_SIZE = 500

// Column lists mirror the real schema in supabase/migrations/*.sql and
// lib/supabase/types.ts. Fields named by the task but absent from the schema
// (competition "code"/"season start/end", team "tla"/"venue", fixture
// extra-time/penalty scores) are intentionally NOT invented here.
const COMPETITION_COLUMNS = [
  "id",
  "provider",
  "provider_competition_id",
  "slug",
  "name",
  "short_name",
  "country",
  "competition_type",
  "current_season",
  "logo_url",
  "is_active",
  "created_at",
  "updated_at",
].join(",")

const TEAM_COLUMNS = [
  "id",
  "provider",
  "provider_team_id",
  "name",
  "short_name",
  "slug",
  "country",
  "logo_url",
  "created_at",
  "updated_at",
].join(",")

const FIXTURE_COLUMNS = [
  "id",
  "provider",
  "provider_fixture_id",
  "competition_id",
  "season",
  "round",
  "matchweek",
  "stage",
  "home_team_id",
  "away_team_id",
  "kickoff_at",
  "venue_name",
  "venue_city",
  "status",
  "elapsed_minutes",
  "home_score",
  "away_score",
  "halftime_home_score",
  "halftime_away_score",
  "fulltime_home_score",
  "fulltime_away_score",
  "winner_team_id",
  "source_updated_at",
  "created_at",
  "updated_at",
].join(",")

// --- paginated read ----------------------------------------------------------

async function fetchAll<T>(table: "competitions" | "teams" | "fixtures", columns: string): Promise<T[]> {
  const db = getAdminSupabase()
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .order("id")
      .range(from, from + PAGE_SIZE - 1)
    if (error) {
      throw new Error(`failed to page ${table} (offset ${from}): ${error.message}`)
    }
    const page = (data ?? []) as unknown as T[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return rows
}

// --- deterministic sort ------------------------------------------------------

function sortCompetitions(rows: Competition[]): Competition[] {
  return [...rows].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1
    return a.provider_competition_id - b.provider_competition_id
  })
}

function sortTeams(rows: Team[]): Team[] {
  return [...rows].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1
    return a.provider_team_id - b.provider_team_id
  })
}

function sortFixtures(rows: Fixture[]): Fixture[] {
  return [...rows].sort((a, b) => {
    const ka = a.kickoff_at ?? ""
    const kb = b.kickoff_at ?? ""
    if (ka !== kb) return ka < kb ? -1 : 1
    return a.provider_fixture_id - b.provider_fixture_id
  })
}

// --- status helpers ----------------------------------------------------------

function isFinished(status: Fixture["status"] | null | undefined): boolean {
  return status === "FINISHED"
}

function isNotStarted(status: Fixture["status"] | null | undefined): boolean {
  return status === "SCHEDULED" || status === "TIMED"
}

// --- manifest ----------------------------------------------------------------

function computeManifest(
  competitions: Competition[],
  _teams: Team[],
  fixtures: Fixture[],
): StaticManifest {
  const finishedTotal = fixtures.filter((f) => isFinished(f.status)).length
  const scheduledTotal = fixtures.filter((f) => isNotStarted(f.status)).length

  const teamsByCompetition = new Map<string, Set<string>>()
  const fixturesByCompetition = new Map<string, number>()
  const finishedByCompetition = new Map<string, number>()
  const upcomingByCompetition = new Map<string, number>()

  for (const c of competitions) {
    teamsByCompetition.set(c.id, new Set())
    fixturesByCompetition.set(c.id, 0)
    finishedByCompetition.set(c.id, 0)
    upcomingByCompetition.set(c.id, 0)
  }

  for (const f of fixtures) {
    teamsByCompetition.get(f.competition_id)?.add(f.home_team_id)
    teamsByCompetition.get(f.competition_id)?.add(f.away_team_id)
    fixturesByCompetition.set(f.competition_id, (fixturesByCompetition.get(f.competition_id) ?? 0) + 1)
    if (isFinished(f.status)) {
      finishedByCompetition.set(f.competition_id, (finishedByCompetition.get(f.competition_id) ?? 0) + 1)
    }
    if (isNotStarted(f.status)) {
      upcomingByCompetition.set(f.competition_id, (upcomingByCompetition.get(f.competition_id) ?? 0) + 1)
    }
  }

  const competitionManifests: CompetitionManifest[] = competitions.map((c) => ({
    slug: c.slug,
    season: c.current_season,
    teams: teamsByCompetition.get(c.id)?.size ?? 0,
    fixtures: fixturesByCompetition.get(c.id) ?? 0,
    finishedFixtures: finishedByCompetition.get(c.id) ?? 0,
    upcomingFixtures: upcomingByCompetition.get(c.id) ?? 0,
  }))

  const sourceLastUpdatedAt = fixtures.reduce<string | null>((max, f) => {
    const s = f.source_updated_at
    if (!s) return max
    return max === null || s > max ? s : max
  }, null)

  return {
    schemaVersion: STATIC_SCHEMA_VERSION,
    provider: PROVIDER,
    exportedAt: new Date().toISOString(),
    sourceLastUpdatedAt,
    counts: {
      competitions: competitions.length,
      teams: _teams.length,
      fixtures: fixtures.length,
      finishedFixtures: finishedTotal,
      scheduledFixtures: scheduledTotal,
    },
    competitions: competitionManifests,
  }
}

// --- pre-write integrity validation -------------------------------------------

/**
 * Validates the in-memory snapshot before anything is written. Any failure here
 * aborts the export, so an existing valid snapshot is never overwritten.
 */
function assertIntegrity(competitions: Competition[], teams: Team[], fixtures: Fixture[]): void {
  const problems: string[] = []

  if (competitions.length === 0) problems.push("competitions is empty")
  if (teams.length === 0) problems.push("teams is empty")
  if (fixtures.length === 0) problems.push("fixtures is empty")

  const competitionIds = new Set<string>()
  const competitionSlugs = new Set<string>()
  const competitionKeys = new Set<string>()
  for (const c of competitions) {
    if (!c.id) problems.push("competition with empty id")
    else if (competitionIds.has(c.id)) problems.push(`duplicate competition id ${c.id}`)
    else competitionIds.add(c.id)

    if (!c.slug) problems.push(`competition ${c.id} with empty slug`)
    else if (competitionSlugs.has(c.slug)) problems.push(`duplicate competition slug ${c.slug}`)
    else competitionSlugs.add(c.slug)

    const key = `${c.provider}/${c.provider_competition_id}`
    if (competitionKeys.has(key)) problems.push(`duplicate competition provider id ${key}`)
    else competitionKeys.add(key)
  }

  const teamIds = new Set<string>()
  const teamSlugs = new Set<string>()
  const teamKeys = new Set<string>()
  for (const t of teams) {
    if (!t.id) problems.push("team with empty id")
    else if (teamIds.has(t.id)) problems.push(`duplicate team id ${t.id}`)
    else teamIds.add(t.id)

    if (!t.slug) problems.push(`team ${t.id} with empty slug`)
    else if (teamSlugs.has(t.slug)) problems.push(`duplicate team slug ${t.slug}`)
    else teamSlugs.add(t.slug)

    const key = `${t.provider}/${t.provider_team_id}`
    if (teamKeys.has(key)) problems.push(`duplicate team provider id ${key}`)
    else teamKeys.add(key)
  }

  const fixtureIds = new Set<string>()
  const fixtureKeys = new Set<string>()
  for (const f of fixtures) {
    if (!f.id) problems.push("fixture with empty id")
    else if (fixtureIds.has(f.id)) problems.push(`duplicate fixture id ${f.id}`)
    else fixtureIds.add(f.id)

    const key = `${f.provider}/${f.provider_fixture_id}`
    if (fixtureKeys.has(key)) problems.push(`duplicate fixture provider id ${key}`)
    else fixtureKeys.add(key)

    if (!competitionIds.has(f.competition_id)) {
      problems.push(`fixture ${f.id} references unknown competition ${f.competition_id}`)
    }
    if (!teamIds.has(f.home_team_id)) {
      problems.push(`fixture ${f.id} references unknown home team ${f.home_team_id}`)
    }
    if (!teamIds.has(f.away_team_id)) {
      problems.push(`fixture ${f.id} references unknown away team ${f.away_team_id}`)
    }
    if (f.home_team_id && f.home_team_id === f.away_team_id) {
      problems.push(`fixture ${f.id} has home_team_id === away_team_id`)
    }
    if (f.winner_team_id != null && f.winner_team_id !== f.home_team_id && f.winner_team_id !== f.away_team_id) {
      problems.push(`fixture ${f.id} winner ${f.winner_team_id} is neither home nor away`)
    }
    if (f.status == null || !FIXTURE_STATUSES.includes(f.status as (typeof FIXTURE_STATUSES)[number])) {
      problems.push(`fixture ${f.id} has unknown/null status ${String(f.status)}`)
    }

    for (const [label, score] of [
      ["home_score", f.home_score],
      ["away_score", f.away_score],
      ["halftime_home_score", f.halftime_home_score],
      ["halftime_away_score", f.halftime_away_score],
      ["fulltime_home_score", f.fulltime_home_score],
      ["fulltime_away_score", f.fulltime_away_score],
    ] as const) {
      if (score != null && score < 0) problems.push(`fixture ${f.id} has negative ${label}`)
    }

    if (isNotStarted(f.status) && (f.home_score != null || f.away_score != null)) {
      problems.push(`fixture ${f.id} not started but carries a score`)
    }
    if (isFinished(f.status) && (f.home_score == null || f.away_score == null)) {
      problems.push(`fixture ${f.id} finished but missing a score`)
    }
    if (f.kickoff_at == null || Number.isNaN(Date.parse(f.kickoff_at))) {
      problems.push(`fixture ${f.id} has invalid kickoff_at ${String(f.kickoff_at)}`)
    }
  }

  if (problems.length > 0) {
    throw new Error(`integrity check failed:\n- ${problems.join("\n- ")}`)
  }
}

// --- atomic write ------------------------------------------------------------

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
  renameSync(tmp, filePath)
}

// --- main ---------------------------------------------------------------------

async function main(): Promise<void> {
  loadSyncEnv()

  const competitions = sortCompetitions(await fetchAll<Competition>("competitions", COMPETITION_COLUMNS))
  const teams = sortTeams(await fetchAll<Team>("teams", TEAM_COLUMNS))
  const fixtures = sortFixtures(await fetchAll<Fixture>("fixtures", FIXTURE_COLUMNS))

  // Validate before writing anything so an existing valid snapshot is preserved.
  assertIntegrity(competitions, teams, fixtures)

  const manifest = computeManifest(competitions, teams, fixtures)

  const outDir = join(process.cwd(), "data", "football")
  mkdirSync(outDir, { recursive: true })

  writeJsonAtomic(join(outDir, "competitions.json"), competitions)
  writeJsonAtomic(join(outDir, "teams.json"), teams)
  writeJsonAtomic(join(outDir, "fixtures.json"), fixtures)
  writeJsonAtomic(join(outDir, "manifest.json"), manifest)

  console.log(
    `exported ${competitions.length} competitions, ${teams.length} teams, ` +
      `${fixtures.length} fixtures -> ${outDir}`,
  )
  console.log(
    `manifest: ${manifest.counts.finishedFixtures} finished, ` +
      `${manifest.counts.scheduledFixtures} scheduled (source last updated ${manifest.sourceLastUpdatedAt ?? "n/a"})`,
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
