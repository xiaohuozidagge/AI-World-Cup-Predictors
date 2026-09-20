import type { FixtureStatus } from "@/lib/supabase/types"

/**
 * Pure club-domain logic (Phase II) shared by the Supabase query layer
 * (`club-queries.ts`) and the static JSON query layer (`static-club-queries.ts`).
 *
 * This module has **no I/O** — no Supabase, no `fetch`, no `server-only`, no
 * environment variables — so it can be unit-tested in isolation and reused by
 * both the dynamic Champions League pages and the static club pages. Everything
 * in here is deterministic given its inputs.
 *
 * `club-queries.ts` re-exports this module so the existing import sites (the
 * club pages, the sitemap and the tests) keep working unchanged.
 */

// --- status sets -------------------------------------------------------------

export const UPCOMING_STATUSES: FixtureStatus[] = ["SCHEDULED", "TIMED"]

// --- public shapes -----------------------------------------------------------

export interface Club {
  id: string
  name: string
  shortName: string | null
  slug: string
  country: string | null
}

export interface ClubCompetition {
  id: string
  slug: string
  name: string
  shortName: string | null
  country: string | null
  currentSeason: number | null
}

export interface ClubWithCompetitions extends Club {
  competitions: ClubCompetition[]
}

export interface ClubFixture {
  id: string
  /** Present on real DB fixtures; optional so hand-built test fixtures stay valid. */
  providerFixtureId?: number
  kickoffAt: string
  status: FixtureStatus
  stage: string | null
  matchweek: number | null
  season: number
  homeTeam: Club
  awayTeam: Club
  homeScore: number | null
  awayScore: number | null
  competition: ClubCompetition
  sourceUpdatedAt: string | null
  updatedAt: string | null
}

export type MatchOutcome = "W" | "D" | "L"

export interface ClubSplitRecord {
  played: number
  won: number
  drawn: number
  lost: number
  goalsFor: number
  goalsAgainst: number
  goalDifference: number
}

export interface ClubRecord extends ClubSplitRecord {
  home: ClubSplitRecord
  away: ClubSplitRecord
  form: MatchOutcome[]
}

export interface ClubStatsResult {
  overall: ClubRecord
  byCompetition: { competition: ClubCompetition; stats: ClubSplitRecord }[]
}

export interface ClubPageData {
  club: Club
  competitions: ClubCompetition[]
  stats: ClubStatsResult
  upcoming: ClubFixture[]
  recent: ClubFixture[]
  lastUpdatedAt: string | null
  currentSeason: number | null
}

/**
 * Three-way lookup result so a dynamic page can tell an unknown slug (→ real
 * 404) from a temporary database failure (→ degrade gracefully).
 */
export type ClubLookup = { status: "found"; club: Club } | { status: "not_found" } | { status: "error" }

export type ClubPageResult =
  | { status: "ok"; data: ClubPageData }
  | { status: "not_found" }
  | { status: "error" }

// --- competition ordering ----------------------------------------------------

const COMPETITION_SLUG_ORDER = ["premier-league", "champions-league"]

export function compareCompetitions(a: ClubCompetition, b: ClubCompetition): number {
  const ia = COMPETITION_SLUG_ORDER.indexOf(a.slug)
  const ib = COMPETITION_SLUG_ORDER.indexOf(b.slug)
  const ra = ia === -1 ? Number.MAX_SAFE_INTEGER : ia
  const rb = ib === -1 ? Number.MAX_SAFE_INTEGER : ib
  return ra - rb || a.name.localeCompare(b.name)
}

export function distinctCompetitions(fixtures: ClubFixture[]): ClubCompetition[] {
  const map = new Map<string, ClubCompetition>()
  for (const f of fixtures) {
    if (!map.has(f.competition.id)) map.set(f.competition.id, f.competition)
  }
  return [...map.values()].sort(compareCompetitions)
}

export function maxCurrentSeason(comps: ClubCompetition[]): number | null {
  let max: number | null = null
  for (const c of comps) {
    if (c.currentSeason != null && (max == null || c.currentSeason > max)) max = c.currentSeason
  }
  return max
}

// --- pure stats math ---------------------------------------------------------

type FinishedClubFixture = ClubFixture & { homeScore: number; awayScore: number }

function isFinishedWithScore(f: ClubFixture): f is FinishedClubFixture {
  return f.status === "FINISHED" && f.homeScore != null && f.awayScore != null
}

function emptySplit(): ClubSplitRecord {
  return { played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0 }
}

function emptyRecord(): ClubRecord {
  return { ...emptySplit(), home: emptySplit(), away: emptySplit(), form: [] }
}

function outcomeFor(goalsFor: number, goalsAgainst: number): MatchOutcome {
  if (goalsFor > goalsAgainst) return "W"
  if (goalsFor < goalsAgainst) return "L"
  return "D"
}

function addSplit(rec: ClubSplitRecord, goalsFor: number, goalsAgainst: number, outcome: MatchOutcome): void {
  rec.played += 1
  rec.goalsFor += goalsFor
  rec.goalsAgainst += goalsAgainst
  if (outcome === "W") rec.won += 1
  else if (outcome === "D") rec.drawn += 1
  else rec.lost += 1
  rec.goalDifference = rec.goalsFor - rec.goalsAgainst
}

/**
 * Pure season-stats computation. Counts only FINISHED matches with a real
 * final score; scheduled/postponed/cancelled and null-score matches are
 * ignored. Goals are taken from the club's own perspective (home → home_score,
 * away → away_score). Each fixture is counted exactly once, so a club that
 * plays in both Premier League and Champions League is never double-counted —
 * its two competitions are simply summed into the overall record and split
 * apart in `byCompetition`.
 */
export function computeClubSeasonStats(teamId: string, fixtures: ClubFixture[]): ClubStatsResult {
  const finished = fixtures.filter(isFinishedWithScore)
  // Most recent first, for the last-5 form.
  const sorted = [...finished].sort((a, b) => b.kickoffAt.localeCompare(a.kickoffAt))

  const overall = emptyRecord()
  const byComp = new Map<string, { competition: ClubCompetition; stats: ClubSplitRecord }>()

  for (const f of sorted) {
    const isHome = f.homeTeam.id === teamId
    const goalsFor = isHome ? f.homeScore : f.awayScore
    const goalsAgainst = isHome ? f.awayScore : f.homeScore
    const outcome = outcomeFor(goalsFor, goalsAgainst)

    addSplit(overall, goalsFor, goalsAgainst, outcome)
    addSplit(isHome ? overall.home : overall.away, goalsFor, goalsAgainst, outcome)

    let entry = byComp.get(f.competition.id)
    if (!entry) {
      entry = { competition: f.competition, stats: emptySplit() }
      byComp.set(f.competition.id, entry)
    }
    addSplit(entry.stats, goalsFor, goalsAgainst, outcome)
  }

  overall.form = sorted.slice(0, 5).map((f) => {
    const isHome = f.homeTeam.id === teamId
    const goalsFor = isHome ? f.homeScore : f.awayScore
    const goalsAgainst = isHome ? f.awayScore : f.homeScore
    return outcomeFor(goalsFor, goalsAgainst)
  })

  return {
    overall,
    byCompetition: [...byComp.values()].sort((a, b) => compareCompetitions(a.competition, b.competition)),
  }
}

// --- pure upcoming / recent / freshness helpers ------------------------------

/**
 * Upcoming fixtures for a club: scheduled/timed fixtures whose kickoff has not
 * passed `nowIso` (when omitted, every scheduled/timed fixture counts — the
 * static snapshot has no meaningful request-time "now"). Sorted soonest-first.
 */
export function upcomingClubFixtures(fixtures: ClubFixture[], limit = 5, nowIso?: string): ClubFixture[] {
  const cutoff = nowIso ? new Date(nowIso).getTime() : Number.NEGATIVE_INFINITY
  return fixtures
    .filter((f) => UPCOMING_STATUSES.includes(f.status) && new Date(f.kickoffAt).getTime() >= cutoff)
    .sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt))
    .slice(0, limit)
}

/** The club's most recent FINISHED fixtures, most recent first. */
export function recentClubResults(fixtures: ClubFixture[], limit = 10): ClubFixture[] {
  return fixtures
    .filter((f) => f.status === "FINISHED")
    .sort((a, b) => b.kickoffAt.localeCompare(a.kickoffAt))
    .slice(0, limit)
}

/** The freshest fixture timestamp (source_updated_at or updated_at) across a club's fixtures. */
export function maxClubFixtureTimestamp(fixtures: ClubFixture[]): string | null {
  let best: string | null = null
  for (const f of fixtures) {
    for (const ts of [f.sourceUpdatedAt, f.updatedAt]) {
      if (ts && (best == null || ts > best)) best = ts
    }
  }
  return best
}
