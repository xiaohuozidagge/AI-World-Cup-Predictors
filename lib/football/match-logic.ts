import type { FixtureStatus } from "@/lib/supabase/types"
import type { StaticManifest } from "./static-types"
import manifestJson from "@/data/football/manifest.json"
import { formatUtcDate, formatUtcTime } from "@/lib/format-utc"
import { matchContextLabel, type MatchCardFixture } from "./match-url"

/**
 * Pure match-domain logic (Phase 8) shared by the Supabase query layer
 * (`match-queries.ts`) and the static JSON query layer (`static-queries.ts`).
 *
 * This module has **no I/O** — no Supabase, no `fetch`, no `server-only` — so it
 * is safe to import from Server Components, the static data layer, and Client
 * Components (the matches directory's client-side filter). Everything in here is
 * deterministic given its inputs, which keeps the server render and client
 * render byte-identical (no hydration mismatch).
 *
 * `match-queries.ts` re-exports this module so the existing import sites (the
 * Champions League routes, the sitemap, and the tests) keep working unchanged.
 */

// --- status sets -------------------------------------------------------------

export const UPCOMING_STATUSES: FixtureStatus[] = ["SCHEDULED", "TIMED"]
export const IN_PROGRESS_STATUSES: FixtureStatus[] = ["LIVE", "HALFTIME"]

const staticManifest = manifestJson as unknown as StaticManifest

/**
 * The single "data as of" timestamp for the static snapshot: the source's last
 * update time, falling back to the export time when the source time is absent.
 * It is read from `data/football/manifest.json` (bundled at build time), never
 * from `new Date()`/`Date.now()` or a hard-coded date, so repeated builds from
 * the same snapshot produce byte-identical output.
 */
export const STATIC_DATA_AS_OF: string = staticManifest.sourceLastUpdatedAt ?? staticManifest.exportedAt

/**
 * @deprecated Use `STATIC_DATA_AS_OF`. Kept as an alias because the
 * (unmodifiable) `/premier-league/matches` page and the club query layer import
 * it under this name. It is no longer a 1970 sentinel — it carries the real
 * snapshot time above.
 */
export const STATIC_NOW = STATIC_DATA_AS_OF

// --- public shapes -----------------------------------------------------------

export interface MatchTeam {
  id: string
  name: string
  shortName: string | null
  slug: string
}

export interface MatchCompetition {
  id: string
  slug: string
  name: string
  shortName: string | null
  currentSeason: number | null
}

/** The full fixture shape used by the match detail page. */
export interface MatchDetailFixture {
  id: string
  providerFixtureId: number
  competitionSlug: string
  season: number
  round: string | null
  matchweek: number | null
  stage: string | null
  kickoffAt: string
  venueName: string | null
  venueCity: string | null
  status: FixtureStatus
  elapsedMinutes: number | null
  homeScore: number | null
  awayScore: number | null
  halftimeHomeScore: number | null
  halftimeAwayScore: number | null
  fulltimeHomeScore: number | null
  fulltimeAwayScore: number | null
  winnerTeamId: string | null
  sourceUpdatedAt: string | null
  updatedAt: string | null
  competition: MatchCompetition
  homeTeam: MatchTeam
  awayTeam: MatchTeam
}

export interface SeasonStats {
  played: number
  won: number
  drawn: number
  lost: number
  goalsFor: number
  goalsAgainst: number
  goalDifference: number
}

export type MatchOutcome = "W" | "D" | "L"

export interface FormEntry {
  fixtureId: string
  kickoffAt: string
  competitionName: string
  opponent: MatchTeam
  teamScore: number
  opponentScore: number
  outcome: MatchOutcome
  isHome: boolean
}

export interface HeadToHeadEntry {
  fixtureId: string
  kickoffAt: string
  competitionName: string
  homeTeam: MatchTeam
  awayTeam: MatchTeam
  homeScore: number
  awayScore: number
}

export interface MatchDirectoryFilter {
  matchweek: number | null
  stage: string | null
}

export interface FilterOptions {
  matchweeks: number[]
  stages: string[]
  matchdays: number[]
}

export interface MatchDirectoryData {
  competition: MatchCompetition
  fixtures: MatchCardFixture[]
  filterOptions: FilterOptions
  lastUpdatedAt: string | null
}

export interface MatchPageData {
  fixture: MatchDetailFixture
  homeStats: SeasonStats
  awayStats: SeasonStats
  homeForm: FormEntry[]
  awayForm: FormEntry[]
  headToHead: HeadToHeadEntry[]
  related: MatchDetailFixture[]
}

export type MatchLookup =
  | { status: "found"; fixture: MatchDetailFixture }
  | { status: "not_found" }
  | { status: "error" }

export type MatchRouteResolution =
  | { kind: "ok"; data: MatchPageData }
  | { kind: "redirect"; canonicalSlug: string }
  | { kind: "not_found" }
  | { kind: "error" }

export interface MatchSitemapEntry {
  competitionSlug: string
  providerFixtureId: number
  homeTeamSlug: string
  awayTeamSlug: string
  status: FixtureStatus
  lastModified: string | null
}

// --- pure directory helpers --------------------------------------------------

/** A minimal shape every directory grouping helper needs. */
export interface DirectoryFixtureLike {
  status: FixtureStatus
  kickoffAt: string
  matchweek: number | null
  stage: string | null
}

export interface MatchPartition<T> {
  inProgress: T[]
  upcoming: T[]
  results: T[]
  other: T[]
}

export function distinctMatchweeks(fixtures: { matchweek: number | null }[]): number[] {
  const set = new Set<number>()
  for (const f of fixtures) if (f.matchweek != null) set.add(f.matchweek)
  return [...set].sort((a, b) => a - b)
}

export function distinctStages(fixtures: { stage: string | null }[]): string[] {
  const set = new Set<string>()
  for (const f of fixtures) if (f.stage) set.add(f.stage)
  return [...set].sort()
}

export function filterFixtures<T extends DirectoryFixtureLike>(
  fixtures: T[],
  filter: MatchDirectoryFilter,
): T[] {
  return fixtures.filter((f) => {
    if (filter.matchweek != null && f.matchweek !== filter.matchweek) return false
    if (filter.stage != null && f.stage !== filter.stage) return false
    return true
  })
}

/**
 * Group fixtures into In Progress / Upcoming / Results, plus a fallback bucket
 * for postponed/suspended/cancelled so every fixture stays reachable.
 *
 * Grouping is driven entirely by status, never by clock time, so a static
 * snapshot and a live page agree and a stale-but-still-`SCHEDULED`/`TIMED`
 * fixture is never mis-bucketed as "other":
 *
 * - `FINISHED` → Results
 * - `LIVE` / `HALFTIME` → In Progress
 * - `SCHEDULED` / `TIMED` → Upcoming
 * - `POSTPONED` / `SUSPENDED` / `CANCELLED` → other
 *
 * Kickoff time is used only for deterministic ordering within each bucket.
 */
export function partitionFixtures<T extends DirectoryFixtureLike>(fixtures: T[]): MatchPartition<T> {
  const inProgress: T[] = []
  const upcoming: T[] = []
  const results: T[] = []
  const other: T[] = []

  for (const f of fixtures) {
    if (IN_PROGRESS_STATUSES.includes(f.status)) inProgress.push(f)
    else if (f.status === "FINISHED") results.push(f)
    else if (UPCOMING_STATUSES.includes(f.status)) upcoming.push(f)
    else other.push(f)
  }

  inProgress.sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt))
  upcoming.sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt))
  results.sort((a, b) => b.kickoffAt.localeCompare(a.kickoffAt))
  other.sort((a, b) => b.kickoffAt.localeCompare(a.kickoffAt))
  return { inProgress, upcoming, results, other }
}

export interface PageSlice<T> {
  items: T[]
  total: number
  page: number
  totalPages: number
}

export function paginate<T>(items: T[], page: number, pageSize: number): PageSlice<T> {
  const total = items.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const start = (safePage - 1) * pageSize
  return { items: items.slice(start, start + pageSize), total, page: safePage, totalPages }
}

/** Whitelist-validated query-string parsers — never pass raw strings to the DB. */
export function parsePositiveInt(raw: unknown): number | null {
  const s = Array.isArray(raw) ? raw[0] : raw
  if (typeof s !== "string" || !/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

export function parseWhitelistedInt(raw: unknown, allowed: number[]): number | null {
  const n = parsePositiveInt(raw)
  return n != null && allowed.includes(n) ? n : null
}

export function parseWhitelistedString(raw: unknown, allowed: string[]): string | null {
  const s = Array.isArray(raw) ? raw[0] : raw
  return typeof s === "string" && allowed.includes(s) ? s : null
}

// --- pure stats / metadata helpers ------------------------------------------

/** P/W/D/L/GF/GA/GD from the team's own perspective over FINISHED, scored matches. */
export function computeSeasonStats(teamId: string, fixtures: MatchDetailFixture[]): SeasonStats {
  const stats: SeasonStats = {
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDifference: 0,
  }
  for (const f of fixtures) {
    if (f.status !== "FINISHED" || f.homeScore == null || f.awayScore == null) continue
    const isHome = f.homeTeam.id === teamId
    const gf = isHome ? f.homeScore : f.awayScore
    const ga = isHome ? f.awayScore : f.homeScore
    stats.played += 1
    stats.goalsFor += gf
    stats.goalsAgainst += ga
    if (gf > ga) stats.won += 1
    else if (gf < ga) stats.lost += 1
    else stats.drawn += 1
  }
  stats.goalDifference = stats.goalsFor - stats.goalsAgainst
  return stats
}

export function toFormEntry(f: MatchDetailFixture, teamId: string): FormEntry {
  const isHome = f.homeTeam.id === teamId
  const teamScore = isHome ? (f.homeScore as number) : (f.awayScore as number)
  const opponentScore = isHome ? (f.awayScore as number) : (f.homeScore as number)
  return {
    fixtureId: f.id,
    kickoffAt: f.kickoffAt,
    competitionName: f.competition.name,
    opponent: isHome ? f.awayTeam : f.homeTeam,
    teamScore,
    opponentScore,
    outcome: teamScore > opponentScore ? "W" : teamScore < opponentScore ? "L" : "D",
    isHome,
  }
}

/** `{Home} vs {Away} Result & Score` when finished, else `{Home} vs {Away}: {date} & {time}`. */
export function buildMatchTitle(fixture: MatchDetailFixture): string {
  const matchup = `${fixture.homeTeam.name} vs ${fixture.awayTeam.name}`
  if (fixture.status === "FINISHED") return `${matchup} Result & Score`
  return `${matchup}: ${formatUtcDate(fixture.kickoffAt)} & ${formatUtcTime(fixture.kickoffAt)}`
}

/** Dynamic description: names, competition, date, UTC time, and the real score when finished. */
export function buildMatchDescription(fixture: MatchDetailFixture): string {
  const matchup = `${fixture.homeTeam.name} vs ${fixture.awayTeam.name}`
  const when = `${formatUtcDate(fixture.kickoffAt)} at ${formatUtcTime(fixture.kickoffAt)}`
  const round = matchContextLabel(fixture.stage, fixture.matchweek, fixture.competition.slug)
  const score =
    fixture.status === "FINISHED" && fixture.homeScore != null && fixture.awayScore != null
      ? `, final score ${fixture.homeScore}-${fixture.awayScore}`
      : ""
  return `View the ${matchup} ${round} fixture in the ${fixture.competition.name} on ${when}${score}. Match data includes team season statistics, recent form and head-to-head results.`
}

/** Sitemap priority: future/in-progress 0.7, finished 0.6, cancelled/postponed 0.3. */
export function matchSitemapPriority(status: FixtureStatus): number {
  if (status === "FINISHED") return 0.6
  if (status === "POSTPONED" || status === "CANCELLED" || status === "SUSPENDED") return 0.3
  return 0.7
}

export function toCardFixture(f: MatchDetailFixture): MatchCardFixture {
  return {
    id: f.id,
    providerFixtureId: f.providerFixtureId,
    competitionSlug: f.competitionSlug,
    kickoffAt: f.kickoffAt,
    status: f.status,
    stage: f.stage,
    matchweek: f.matchweek,
    homeTeam: f.homeTeam,
    awayTeam: f.awayTeam,
    homeScore: f.homeScore,
    awayScore: f.awayScore,
  }
}

export function maxFixtureTimestamp(fixtures: MatchDetailFixture[]): string | null {
  let best: string | null = null
  for (const f of fixtures) {
    for (const ts of [f.sourceUpdatedAt, f.updatedAt]) {
      if (ts && (best == null || ts > best)) best = ts
    }
  }
  return best
}

// --- pure form / H2H / related computations (shared by both query layers) ----

/** The team's last `limit` finished matches strictly before `beforeDate`. */
export function computeRecentForm(
  teamId: string,
  fixtures: MatchDetailFixture[],
  beforeDate: string,
  limit = 5,
): FormEntry[] {
  const cutoff = new Date(beforeDate).getTime()
  return fixtures
    .filter(
      (f) =>
        f.status === "FINISHED" &&
        f.homeScore != null &&
        f.awayScore != null &&
        new Date(f.kickoffAt).getTime() < cutoff,
    )
    .slice(0, limit)
    .map((f) => toFormEntry(f, teamId))
}

/** Prior meetings between two teams, strictly before `beforeDate` (real history only). */
export function computeHeadToHead(
  homeTeamId: string,
  awayTeamId: string,
  fixtures: MatchDetailFixture[],
  beforeDate: string,
  limit = 5,
): HeadToHeadEntry[] {
  const cutoff = new Date(beforeDate).getTime()
  return fixtures
    .filter((f) => f.homeTeam.id === awayTeamId || f.awayTeam.id === awayTeamId)
    .filter((f) => f.status === "FINISHED" && f.homeScore != null && f.awayScore != null)
    .filter((f) => new Date(f.kickoffAt).getTime() < cutoff)
    .slice(0, limit)
    .map((f) => ({
      fixtureId: f.id,
      kickoffAt: f.kickoffAt,
      competitionName: f.competition.name,
      homeTeam: f.homeTeam,
      awayTeam: f.awayTeam,
      homeScore: f.homeScore as number,
      awayScore: f.awayScore as number,
    }))
}

/** Other fixtures in the same competition and round/stage, closest in time first. */
export function computeRelatedFixtures(
  fixture: MatchDetailFixture,
  allCompetitionFixtures: MatchDetailFixture[],
  limit = 6,
): MatchDetailFixture[] {
  const others = allCompetitionFixtures.filter((f) => f.id !== fixture.id)
  let pool = fixture.matchweek != null ? others.filter((f) => f.matchweek === fixture.matchweek) : []
  if (pool.length === 0) pool = others.filter((f) => f.stage === fixture.stage)
  if (pool.length === 0) pool = others

  const target = new Date(fixture.kickoffAt).getTime()
  return pool
    .sort(
      (a, b) =>
        Math.abs(new Date(a.kickoffAt).getTime() - target) -
        Math.abs(new Date(b.kickoffAt).getTime() - target),
    )
    .slice(0, limit)
}
