import "server-only"

import { cache } from "react"
import { unstable_cache } from "next/cache"

import { getPublicSupabase } from "@/lib/supabase/public"
import type { FixtureStatus } from "@/lib/supabase/types"
import { REVALIDATE_SECONDS } from "./queries"
import {
  compareCompetitions,
  computeClubSeasonStats,
  distinctCompetitions,
  maxClubFixtureTimestamp,
  maxCurrentSeason,
  recentClubResults,
  upcomingClubFixtures,
  type Club,
  type ClubCompetition,
  type ClubFixture,
  type ClubLookup,
  type ClubPageResult,
  type ClubStatsResult,
  type ClubWithCompetitions,
} from "./club-logic"

// Re-export the pure types and helpers so existing import sites (the club pages,
// the sitemap and the tests) keep working against the same names.
export * from "./club-logic"

/**
 * Public, read-only query layer for clubs (Phase 6).
 *
 * Mirrors `lib/football/queries.ts`: every query talks only to the *public*
 * client (anon role), never the secret key, and never calls football-data.org
 * from the request path. RLS restricts the anon role to SELECT on competitions
 * / teams / fixtures.
 *
 * No N+1: a club's fixtures, its competitions, its season stats, upcoming,
 * recent results and last-updated timestamp are all derived from ONE cached
 * query (`getClubFixturesAll`) that fetches every fixture where the club is
 * home or away — a club plays ~40–60 matches, so this is a handful of rows.
 * React `cache()` dedupes that query within a request, and `unstable_cache`
 * reuses it for 30 minutes.
 *
 * The stats math and upcoming/recent filtering are pure functions in
 * `./club-logic.ts` (re-exported above), shared with the static JSON layer.
 */

const PROVIDER = "football-data.org"

// --- raw row shapes (supabase returns plain JSON) ----------------------------

interface ClubRaw {
  id: string
  name: string
  short_name: string | null
  slug: string
  country: string | null
}

interface ClubCompetitionRaw {
  id: string
  slug: string
  name: string
  short_name: string | null
  country: string | null
  current_season: number | null
}

interface ClubFixtureRaw {
  id: string
  provider_fixture_id: number
  kickoff_at: string
  status: FixtureStatus
  stage: string | null
  matchweek: number | null
  season: number
  home_score: number | null
  away_score: number | null
  source_updated_at: string | null
  updated_at: string | null
  competition: ClubCompetitionRaw | null
  home_team: ClubRaw | null
  away_team: ClubRaw | null
}

interface TeamCompRefRaw {
  home_team_id: string
  away_team_id: string
  competition_id: string
}

// --- helpers -----------------------------------------------------------------

function logQueryError(scope: string, error: unknown): void {
  const code = (error as { code?: string } | null)?.code
  console.error(`[club queries] ${scope} failed${code ? ` (${code})` : ""}`)
}

function mapClub(raw: ClubRaw): Club {
  return { id: raw.id, name: raw.name, shortName: raw.short_name, slug: raw.slug, country: raw.country }
}

function mapCompetition(raw: ClubCompetitionRaw): ClubCompetition {
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    shortName: raw.short_name,
    country: raw.country,
    currentSeason: raw.current_season,
  }
}

function mapClubFixture(raw: ClubFixtureRaw): ClubFixture | null {
  if (!raw.home_team || !raw.away_team || !raw.competition) return null
  return {
    id: raw.id,
    providerFixtureId: raw.provider_fixture_id,
    kickoffAt: raw.kickoff_at,
    status: raw.status,
    stage: raw.stage,
    matchweek: raw.matchweek,
    season: raw.season,
    homeTeam: mapClub(raw.home_team),
    awayTeam: mapClub(raw.away_team),
    homeScore: raw.home_score,
    awayScore: raw.away_score,
    competition: mapCompetition(raw.competition),
    sourceUpdatedAt: raw.source_updated_at,
    updatedAt: raw.updated_at,
  }
}

// --- queries -----------------------------------------------------------------

export const getAllClubs = cache(
  unstable_cache(
    async (): Promise<ClubWithCompetitions[]> => {
      try {
        const db = getPublicSupabase()
        const [teamsRes, compsRes, mappingRes] = await Promise.all([
          db
            .from("teams")
            .select<string, ClubRaw>("id, name, short_name, slug, country")
            .eq("provider", PROVIDER)
            .order("name", { ascending: true }),
          db
            .from("competitions")
            .select<string, ClubCompetitionRaw>("id, slug, name, short_name, country, current_season")
            .eq("provider", PROVIDER)
            .eq("is_active", true),
          db.from("fixtures").select<string, TeamCompRefRaw>("home_team_id, away_team_id, competition_id"),
        ])

        const firstError = teamsRes.error ?? compsRes.error ?? mappingRes.error
        if (firstError) {
          logQueryError("getAllClubs", firstError)
          return []
        }

        const competitions = (compsRes.data ?? []).map(mapCompetition)
        const compById = new Map(competitions.map((c) => [c.id, c]))

        const teamCompIds = new Map<string, Set<string>>()
        for (const row of mappingRes.data ?? []) {
          for (const teamId of [row.home_team_id, row.away_team_id]) {
            const set = teamCompIds.get(teamId) ?? new Set<string>()
            set.add(row.competition_id)
            teamCompIds.set(teamId, set)
          }
        }

        return (teamsRes.data ?? []).map(mapClub).map((club) => {
          const ids = teamCompIds.get(club.id)
          const competitions = ids
            ? [...ids]
                .map((id) => compById.get(id))
                .filter((c): c is ClubCompetition => c != null)
                .sort(compareCompetitions)
            : []
          return { ...club, competitions }
        })
      } catch (err) {
        logQueryError("getAllClubs", err)
        return []
      }
    },
    ["clubs-hub"],
    { revalidate: REVALIDATE_SECONDS },
  ),
)

export const getClubBySlug = cache(
  unstable_cache(
    async (slug: string): Promise<ClubLookup> => {
      try {
        const db = getPublicSupabase()
        const { data, error } = await db
          .from("teams")
          .select<string, ClubRaw>("id, name, short_name, slug, country")
          .eq("slug", slug)
          .eq("provider", PROVIDER)
          .maybeSingle()
        if (error) {
          logQueryError("getClubBySlug", error)
          return { status: "error" }
        }
        return data ? { status: "found", club: mapClub(data) } : { status: "not_found" }
      } catch (err) {
        logQueryError("getClubBySlug", err)
        return { status: "error" }
      }
    },
    ["club-by-slug"],
    { revalidate: REVALIDATE_SECONDS },
  ),
)

const CLUB_FIXTURE_SELECT = `
  id,
  provider_fixture_id,
  kickoff_at,
  status,
  stage,
  matchweek,
  season,
  home_score,
  away_score,
  source_updated_at,
  updated_at,
  competition:competitions!fixtures_competition_id_fkey(id, slug, name, short_name, country, current_season),
  home_team:teams!fixtures_home_team_id_fkey(id, name, short_name, slug, country),
  away_team:teams!fixtures_away_team_id_fkey(id, name, short_name, slug, country)
`

/** One cached query for every fixture a club plays (home or away). */
const getClubFixturesAll = cache(
  unstable_cache(
    async (teamId: string): Promise<ClubFixture[]> => {
      try {
        const db = getPublicSupabase()
        const { data, error } = await db
          .from("fixtures")
          .select<string, ClubFixtureRaw>(CLUB_FIXTURE_SELECT)
          .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
          .order("kickoff_at", { ascending: false })
        if (error) {
          logQueryError("getClubFixturesAll", error)
          return []
        }
        return (data ?? []).map(mapClubFixture).filter((f): f is ClubFixture => f !== null)
      } catch (err) {
        logQueryError("getClubFixturesAll", err)
        return []
      }
    },
    ["club-fixtures"],
    { revalidate: REVALIDATE_SECONDS },
  ),
)

export async function getClubCompetitions(teamId: string): Promise<ClubCompetition[]> {
  return distinctCompetitions(await getClubFixturesAll(teamId))
}

export async function getClubUpcomingFixtures(teamId: string, limit = 5): Promise<ClubFixture[]> {
  const fixtures = await getClubFixturesAll(teamId)
  return upcomingClubFixtures(fixtures, limit, new Date().toISOString())
}

export async function getClubRecentResults(teamId: string, limit = 10): Promise<ClubFixture[]> {
  const fixtures = await getClubFixturesAll(teamId)
  return recentClubResults(fixtures, limit)
}

export async function getClubSeasonStats(teamId: string): Promise<ClubStatsResult> {
  const fixtures = await getClubFixturesAll(teamId)
  const season = maxCurrentSeason(distinctCompetitions(fixtures))
  const inSeason = season == null ? fixtures : fixtures.filter((f) => f.season === season)
  return computeClubSeasonStats(teamId, inSeason)
}

export async function getClubLastUpdatedAt(teamId: string): Promise<string | null> {
  const fixtures = await getClubFixturesAll(teamId)
  return maxClubFixtureTimestamp(fixtures)
}

/** Single entry point for a club detail page, distinguishing not-found from DB error. */
export async function getClubPageData(slug: string): Promise<ClubPageResult> {
  const lookup = await getClubBySlug(slug)
  if (lookup.status === "not_found") return { status: "not_found" }
  if (lookup.status === "error") return { status: "error" }
  const club = lookup.club

  const [competitions, stats, upcoming, recent, lastUpdatedAt] = await Promise.all([
    getClubCompetitions(club.id),
    getClubSeasonStats(club.id),
    getClubUpcomingFixtures(club.id, 5),
    getClubRecentResults(club.id, 10),
    getClubLastUpdatedAt(club.id),
  ])

  return {
    status: "ok",
    data: {
      club,
      competitions,
      stats,
      upcoming,
      recent,
      lastUpdatedAt,
      currentSeason: maxCurrentSeason(competitions),
    },
  }
}

// --- sitemap ----------------------------------------------------------------

/**
 * Club slugs plus their freshest fixture timestamp, for the sitemap. One
 * teams query + one fixtures query (no per-club N+1). Returns [] on failure so
 * the sitemap still renders its static routes.
 */
export const getClubsForSitemap = cache(
  unstable_cache(
    async (): Promise<{ slug: string; lastModified: string | null }[]> => {
      try {
        const db = getPublicSupabase()
        const [teamsRes, fixturesRes] = await Promise.all([
          db.from("teams").select<string, ClubRaw>("id, slug").eq("provider", PROVIDER),
          db
            .from("fixtures")
            .select<string, { home_team_id: string; away_team_id: string; source_updated_at: string | null; updated_at: string | null }>(
              "home_team_id, away_team_id, source_updated_at, updated_at",
            ),
        ])
        if (teamsRes.error || fixturesRes.error) {
          logQueryError("getClubsForSitemap", teamsRes.error ?? fixturesRes.error)
          return []
        }

        const lastByTeam = new Map<string, string>()
        for (const row of fixturesRes.data ?? []) {
          for (const teamId of [row.home_team_id, row.away_team_id]) {
            for (const ts of [row.source_updated_at, row.updated_at]) {
              if (!ts) continue
              const current = lastByTeam.get(teamId)
              if (!current || ts > current) lastByTeam.set(teamId, ts)
            }
          }
        }

        return (teamsRes.data ?? []).map((t) => ({ slug: t.slug, lastModified: lastByTeam.get(t.id) ?? null }))
      } catch (err) {
        logQueryError("getClubsForSitemap", err)
        return []
      }
    },
    ["clubs-sitemap"],
    { revalidate: REVALIDATE_SECONDS },
  ),
)
