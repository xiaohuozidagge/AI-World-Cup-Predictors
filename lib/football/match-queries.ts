import "server-only"

import { cache } from "react"
import { unstable_cache } from "next/cache"

import { getPublicSupabase } from "@/lib/supabase/public"
import type { FixtureStatus } from "@/lib/supabase/types"
import { REVALIDATE_SECONDS } from "./queries"
import {
  buildMatchSlug,
  parseFixtureIdFromSlug,
  validateCanonicalMatchSlug,
  type MatchCardFixture,
} from "./match-url"
import {
  computeHeadToHead,
  computeRecentForm,
  computeRelatedFixtures,
  computeSeasonStats,
  distinctMatchweeks,
  distinctStages,
  maxFixtureTimestamp,
  toCardFixture,
  type FormEntry,
  type HeadToHeadEntry,
  type MatchCompetition,
  type MatchDetailFixture,
  type MatchDirectoryData,
  type MatchLookup,
  type MatchRouteResolution,
  type MatchSitemapEntry,
  type MatchTeam,
  type SeasonStats,
} from "./match-logic"

// Re-export the pure types and helpers so existing import sites (the Champions
// League routes, the sitemap and the tests) keep working against the same names.
export * from "./match-logic"

/**
 * Public, read-only query layer for match pages (Phase 7).
 *
 * Mirrors `lib/football/club-queries.ts`: every query talks only to the public
 * client (anon role), never the secret key, and never calls football-data.org
 * from the request path. Strict separation between the two competitions is
 * enforced in `getFixtureByProviderId` (a fixture that belongs to the other
 * competition is a 404, not a wrong match).
 *
 * - No N+1: team/competition data is embedded in a single fixtures query, and a
 *   detail page derives its Recent Form / Season Stats / Head-to-Head /
 *   Related Fixtures from a handful of cached, id-keyed queries.
 * - Safe errors: a failed query returns a safe sentinel ([]/null/zeroed stats),
 *   and lookups use a three-way result so the page can tell "unknown id" (→ 404)
 *   from "database down" (→ degrade, never 404 a real match).
 * - The stats math and directory grouping are pure functions in
 *   `./match-logic.ts` (re-exported above), shared with the static JSON layer.
 */

const PROVIDER = "football-data.org"

// --- raw row shapes (supabase returns plain JSON) ----------------------------

interface MatchTeamRaw {
  id: string
  name: string
  short_name: string | null
  slug: string
}

interface MatchCompetitionRaw {
  id: string
  slug: string
  name: string
  short_name: string | null
  current_season: number | null
}

interface MatchFixtureRaw {
  id: string
  provider_fixture_id: number
  season: number
  round: string | null
  matchweek: number | null
  stage: string | null
  kickoff_at: string
  venue_name: string | null
  venue_city: string | null
  status: FixtureStatus
  elapsed_minutes: number | null
  home_score: number | null
  away_score: number | null
  halftime_home_score: number | null
  halftime_away_score: number | null
  fulltime_home_score: number | null
  fulltime_away_score: number | null
  winner_team_id: string | null
  source_updated_at: string | null
  updated_at: string | null
  competition: MatchCompetitionRaw | null
  home_team: MatchTeamRaw | null
  away_team: MatchTeamRaw | null
}

// --- helpers -----------------------------------------------------------------

function logQueryError(scope: string, error: unknown): void {
  const code = (error as { code?: string } | null)?.code
  console.error(`[match queries] ${scope} failed${code ? ` (${code})` : ""}`)
}

function mapTeam(raw: MatchTeamRaw): MatchTeam {
  return { id: raw.id, name: raw.name, shortName: raw.short_name, slug: raw.slug }
}

function mapCompetition(raw: MatchCompetitionRaw): MatchCompetition {
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    shortName: raw.short_name,
    currentSeason: raw.current_season,
  }
}

function mapMatchDetail(raw: MatchFixtureRaw): MatchDetailFixture | null {
  if (!raw.home_team || !raw.away_team || !raw.competition) return null
  return {
    id: raw.id,
    providerFixtureId: raw.provider_fixture_id,
    competitionSlug: raw.competition.slug,
    season: raw.season,
    round: raw.round,
    matchweek: raw.matchweek,
    stage: raw.stage,
    kickoffAt: raw.kickoff_at,
    venueName: raw.venue_name,
    venueCity: raw.venue_city,
    status: raw.status,
    elapsedMinutes: raw.elapsed_minutes,
    homeScore: raw.home_score,
    awayScore: raw.away_score,
    halftimeHomeScore: raw.halftime_home_score,
    halftimeAwayScore: raw.halftime_away_score,
    fulltimeHomeScore: raw.fulltime_home_score,
    fulltimeAwayScore: raw.fulltime_away_score,
    winnerTeamId: raw.winner_team_id,
    sourceUpdatedAt: raw.source_updated_at,
    updatedAt: raw.updated_at,
    competition: mapCompetition(raw.competition),
    homeTeam: mapTeam(raw.home_team),
    awayTeam: mapTeam(raw.away_team),
  }
}

const MATCH_FIXTURE_SELECT = `
  id,
  provider_fixture_id,
  season,
  round,
  matchweek,
  stage,
  kickoff_at,
  venue_name,
  venue_city,
  status,
  elapsed_minutes,
  home_score,
  away_score,
  halftime_home_score,
  halftime_away_score,
  fulltime_home_score,
  fulltime_away_score,
  winner_team_id,
  source_updated_at,
  updated_at,
  competition:competitions!fixtures_competition_id_fkey(id, slug, name, short_name, current_season),
  home_team:teams!fixtures_home_team_id_fkey(id, name, short_name, slug),
  away_team:teams!fixtures_away_team_id_fkey(id, name, short_name, slug)
`

// --- queries -----------------------------------------------------------------

export const getMatchCompetition = cache(
  unstable_cache(
    async (slug: string): Promise<MatchCompetition | null> => {
      try {
        const db = getPublicSupabase()
        const { data, error } = await db
          .from("competitions")
          .select<string, MatchCompetitionRaw>("id, slug, name, short_name, current_season")
          .eq("slug", slug)
          .eq("provider", PROVIDER)
          .maybeSingle()
        if (error) {
          logQueryError("getMatchCompetition", error)
          return null
        }
        return data ? mapCompetition(data) : null
      } catch (err) {
        logQueryError("getMatchCompetition", err)
        return null
      }
    },
    ["match-competition"],
    { revalidate: REVALIDATE_SECONDS },
  ),
)

const getCompetitionFixturesDetail = cache(
  unstable_cache(
    async (competitionId: string): Promise<MatchDetailFixture[]> => {
      try {
        const db = getPublicSupabase()
        const { data, error } = await db
          .from("fixtures")
          .select<string, MatchFixtureRaw>(MATCH_FIXTURE_SELECT)
          .eq("competition_id", competitionId)
          .eq("provider", PROVIDER)
          .order("kickoff_at", { ascending: true })
        if (error) {
          logQueryError("getCompetitionFixturesDetail", error)
          return []
        }
        return (data ?? []).map(mapMatchDetail).filter((f): f is MatchDetailFixture => f !== null)
      } catch (err) {
        logQueryError("getCompetitionFixturesDetail", err)
        return []
      }
    },
    ["match-competition-fixtures"],
    { revalidate: REVALIDATE_SECONDS },
  ),
)

/** All fixtures for a competition as card-shaped rows, ordered by kickoff. */
export async function getCompetitionFixtures(slug: string): Promise<MatchCardFixture[]> {
  const competition = await getMatchCompetition(slug)
  if (!competition) return []
  const detail = await getCompetitionFixturesDetail(competition.id)
  return detail.map(toCardFixture)
}

/** Fixture by its unique provider id, scoped to the requested competition (else 404). */
export const getFixtureByProviderId = cache(
  unstable_cache(
    async (providerFixtureId: number, competitionSlug: string): Promise<MatchLookup> => {
      try {
        const db = getPublicSupabase()
        const { data, error } = await db
          .from("fixtures")
          .select<string, MatchFixtureRaw>(MATCH_FIXTURE_SELECT)
          .eq("provider", PROVIDER)
          .eq("provider_fixture_id", providerFixtureId)
          .maybeSingle()
        if (error) {
          logQueryError("getFixtureByProviderId", error)
          return { status: "error" }
        }
        if (!data) return { status: "not_found" }
        const fixture = mapMatchDetail(data)
        if (!fixture) return { status: "not_found" }
        if (fixture.competition.slug !== competitionSlug) return { status: "not_found" }
        return { status: "found", fixture }
      } catch (err) {
        logQueryError("getFixtureByProviderId", err)
        return { status: "error" }
      }
    },
    ["match-by-provider-id"],
    { revalidate: REVALIDATE_SECONDS },
  ),
)

const getTeamFixturesAll = cache(
  unstable_cache(
    async (teamId: string): Promise<MatchDetailFixture[]> => {
      try {
        const db = getPublicSupabase()
        const { data, error } = await db
          .from("fixtures")
          .select<string, MatchFixtureRaw>(MATCH_FIXTURE_SELECT)
          .eq("provider", PROVIDER)
          .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
          .order("kickoff_at", { ascending: false })
        if (error) {
          logQueryError("getTeamFixturesAll", error)
          return []
        }
        return (data ?? []).map(mapMatchDetail).filter((f): f is MatchDetailFixture => f !== null)
      } catch (err) {
        logQueryError("getTeamFixturesAll", err)
        return []
      }
    },
    ["match-team-fixtures"],
    { revalidate: REVALIDATE_SECONDS },
  ),
)

/** The team's last `limit` finished matches strictly before `beforeDate`. */
export async function getTeamRecentForm(
  teamId: string,
  beforeDate: string,
  limit = 5,
): Promise<FormEntry[]> {
  const fixtures = await getTeamFixturesAll(teamId)
  return computeRecentForm(teamId, fixtures, beforeDate, limit)
}

/** The team's season record, optionally scoped to one competition. */
export async function getTeamSeasonStats(teamId: string, competitionId?: string): Promise<SeasonStats> {
  const fixtures = await getTeamFixturesAll(teamId)
  const scoped = competitionId ? fixtures.filter((f) => f.competition.id === competitionId) : fixtures
  return computeSeasonStats(teamId, scoped)
}

/** Prior meetings between two teams, strictly before `beforeDate` (real DB history only). */
export async function getHeadToHead(
  homeTeamId: string,
  awayTeamId: string,
  beforeDate: string,
  limit = 5,
): Promise<HeadToHeadEntry[]> {
  const fixtures = await getTeamFixturesAll(homeTeamId)
  return computeHeadToHead(homeTeamId, awayTeamId, fixtures, beforeDate, limit)
}

/** Other fixtures in the same competition and round/stage, closest in time first. */
export async function getRelatedFixtures(
  fixture: MatchDetailFixture,
  limit = 6,
): Promise<MatchDetailFixture[]> {
  const all = await getCompetitionFixturesDetail(fixture.competition.id)
  return computeRelatedFixtures(fixture, all, limit)
}

/** Directory data: competition + all card fixtures + filter options + freshness. */
export async function getMatchDirectoryData(slug: string): Promise<MatchDirectoryData | null> {
  const competition = await getMatchCompetition(slug)
  if (!competition) return null
  const detail = await getCompetitionFixturesDetail(competition.id)
  const fixtures = detail.map(toCardFixture)
  return {
    competition,
    fixtures,
    filterOptions: {
      matchweeks: distinctMatchweeks(fixtures),
      stages: distinctStages(fixtures),
      matchdays: distinctMatchweeks(fixtures),
    },
    lastUpdatedAt: maxFixtureTimestamp(detail),
  }
}

/**
 * Resolve a requested match slug into the full detail data, or an instruction
 * for the page (permanent redirect to the canonical slug / 404 / error).
 */
export async function resolveMatch(slug: string, competitionSlug: string): Promise<MatchRouteResolution> {
  const id = parseFixtureIdFromSlug(slug)
  if (id == null) return { kind: "not_found" }

  const lookup = await getFixtureByProviderId(id, competitionSlug)
  if (lookup.status === "error") return { kind: "error" }
  if (lookup.status === "not_found") return { kind: "not_found" }

  const fixture = lookup.fixture
  if (!validateCanonicalMatchSlug(fixture, slug)) {
    return { kind: "redirect", canonicalSlug: buildMatchSlug(fixture) }
  }

  const [homeStats, awayStats, homeForm, awayForm, headToHead, related] = await Promise.all([
    getTeamSeasonStats(fixture.homeTeam.id, fixture.competition.id),
    getTeamSeasonStats(fixture.awayTeam.id, fixture.competition.id),
    getTeamRecentForm(fixture.homeTeam.id, fixture.kickoffAt, 5),
    getTeamRecentForm(fixture.awayTeam.id, fixture.kickoffAt, 5),
    getHeadToHead(fixture.homeTeam.id, fixture.awayTeam.id, fixture.kickoffAt, 5),
    getRelatedFixtures(fixture, 6),
  ])

  return {
    kind: "ok",
    data: { fixture, homeStats, awayStats, homeForm, awayForm, headToHead, related },
  }
}

// --- sitemap ----------------------------------------------------------------

/**
 * Every fixture for the sitemap, with the pieces needed to build its canonical
 * URL and priority. One fixtures query (no per-match N+1). Returns [] on
 * failure so the sitemap still renders its static routes.
 */
export const getMatchesForSitemap = cache(
  unstable_cache(
    async (): Promise<MatchSitemapEntry[]> => {
      try {
        const db = getPublicSupabase()
        const { data, error } = await db
          .from("fixtures")
          .select<
            string,
            {
              provider_fixture_id: number
              status: FixtureStatus
              source_updated_at: string | null
              updated_at: string | null
              competition: { slug: string } | null
              home_team: { slug: string } | null
              away_team: { slug: string } | null
            }
          >(
            `
            provider_fixture_id,
            status,
            source_updated_at,
            updated_at,
            competition:competitions!fixtures_competition_id_fkey(slug),
            home_team:teams!fixtures_home_team_id_fkey(slug),
            away_team:teams!fixtures_away_team_id_fkey(slug)
          `,
          )
          .eq("provider", PROVIDER)
        if (error) {
          logQueryError("getMatchesForSitemap", error)
          return []
        }
        return (data ?? [])
          .filter((r) => r.competition?.slug && r.home_team?.slug && r.away_team?.slug)
          .map((r) => ({
            competitionSlug: r.competition!.slug,
            providerFixtureId: r.provider_fixture_id,
            homeTeamSlug: r.home_team!.slug,
            awayTeamSlug: r.away_team!.slug,
            status: r.status,
            lastModified:
              [r.source_updated_at, r.updated_at].filter((t): t is string => Boolean(t)).sort().pop() ?? null,
          }))
      } catch (err) {
        logQueryError("getMatchesForSitemap", err)
        return []
      }
    },
    ["matches-sitemap"],
    { revalidate: REVALIDATE_SECONDS },
  ),
)
