import "server-only"

import {
  computeHeadToHead,
  computeRecentForm,
  computeRelatedFixtures,
  computeSeasonStats,
  distinctMatchweeks,
  distinctStages,
  maxFixtureTimestamp,
  toCardFixture,
  UPCOMING_STATUSES,
  type MatchCompetition,
  type MatchDetailFixture,
  type MatchDirectoryData,
  type MatchPageData,
  type MatchSitemapEntry,
  type MatchTeam,
} from "./match-logic"
import {
  buildMatchSlug,
  parseFixtureIdFromSlug,
  validateCanonicalMatchSlug,
  type MatchCardFixture,
} from "./match-url"
import {
  fixtureByProviderId,
  getStaticCompetition,
  getStaticFixturesForCompetition,
  getStaticTeamFixtures,
  staticFixtures,
  type StaticCompetition,
  type StaticFixture,
  type StaticTeam,
} from "./static-data"

// Re-export the pure match logic so the tests (and any future consumer) can
// import everything from a single entry point.
export * from "./match-logic"

/**
 * Read-only, synchronous query layer for the static Premier League pages
 * (Phase I). It reads the validated in-memory snapshot in `./static-data.ts`
 * and reuses the pure match logic in `./match-logic.ts`. No Supabase, no
 * data-fetching cache, no `fetch`, no `await` — every function is a pure
 * function of the snapshot, so the pages it feeds can be prerendered at build
 * time.
 */

// --- structural shapes (mirror the Supabase query layer without importing it) --

export interface StaticCompetitionSummary {
  id: string
  slug: string
  name: string
  shortName: string | null
  country: string | null
  currentSeason: number | null
  updatedAt: string | null
}

export interface StaticCompetitionStats {
  teamCount: number
  totalFixtures: number
  finishedFixtures: number
  upcomingFixtures: number
  nextMatchAt: string | null
}

export interface StaticCompetitionPageData {
  competition: StaticCompetitionSummary
  stats: StaticCompetitionStats
  upcoming: MatchCardFixture[]
  recent: MatchCardFixture[]
  lastUpdatedAt: string | null
}

// --- conversion layer (Static* → Match*/card types, no `any`) -----------------

export function toMatchTeam(t: StaticTeam): MatchTeam {
  return { id: t.id, name: t.name, shortName: t.shortName, slug: t.slug }
}

export function toMatchCompetition(c: StaticCompetition): MatchCompetition {
  return { id: c.id, slug: c.slug, name: c.name, shortName: c.shortName, currentSeason: c.currentSeason }
}

export function toCompetitionSummary(c: StaticCompetition): StaticCompetitionSummary {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    shortName: c.shortName,
    country: c.country,
    currentSeason: c.currentSeason,
    updatedAt: c.updatedAt,
  }
}

export function toMatchDetailFixture(f: StaticFixture): MatchDetailFixture {
  return {
    id: f.id,
    providerFixtureId: f.providerFixtureId,
    competitionSlug: f.competition.slug,
    season: f.season,
    round: f.round,
    matchweek: f.matchweek,
    stage: f.stage,
    kickoffAt: f.kickoffAt,
    venueName: f.venueName,
    venueCity: f.venueCity,
    status: f.status,
    elapsedMinutes: f.elapsedMinutes,
    homeScore: f.homeScore,
    awayScore: f.awayScore,
    halftimeHomeScore: f.halftimeHomeScore,
    halftimeAwayScore: f.halftimeAwayScore,
    fulltimeHomeScore: f.fulltimeHomeScore,
    fulltimeAwayScore: f.fulltimeAwayScore,
    winnerTeamId: f.winnerTeamId,
    sourceUpdatedAt: f.sourceUpdatedAt,
    updatedAt: f.updatedAt,
    competition: toMatchCompetition(f.competition),
    homeTeam: toMatchTeam(f.homeTeam),
    awayTeam: toMatchTeam(f.awayTeam),
  }
}

// --- queries -----------------------------------------------------------------

/** League landing-page data: competition + stats + upcoming (12) + recent (10). */
export function getStaticCompetitionPageData(slug: string): StaticCompetitionPageData {
  const competition = getStaticCompetition(slug)
  const detail = getStaticFixturesForCompetition(slug).map(toMatchDetailFixture)

  const finished = detail.filter((f) => f.status === "FINISHED")
  const upcomingAll = detail.filter((f) => UPCOMING_STATUSES.includes(f.status))

  const teamIds = new Set<string>()
  for (const f of detail) {
    teamIds.add(f.homeTeam.id)
    teamIds.add(f.awayTeam.id)
  }

  return {
    competition: toCompetitionSummary(competition),
    stats: {
      teamCount: teamIds.size,
      totalFixtures: detail.length,
      finishedFixtures: finished.length,
      upcomingFixtures: upcomingAll.length,
      nextMatchAt: upcomingAll.length > 0 ? upcomingAll[0].kickoffAt : null,
    },
    upcoming: upcomingAll.slice(0, 12).map(toCardFixture),
    recent: finished
      .sort((a, b) => b.kickoffAt.localeCompare(a.kickoffAt))
      .slice(0, 10)
      .map(toCardFixture),
    lastUpdatedAt: maxFixtureTimestamp(detail),
  }
}

/** Directory data: competition + all card fixtures + filter options + freshness. */
export function getStaticMatchDirectoryData(slug: string): MatchDirectoryData {
  const competition = getStaticCompetition(slug)
  const detail = getStaticFixturesForCompetition(slug).map(toMatchDetailFixture)
  const fixtures = detail.map(toCardFixture)
  return {
    competition: toMatchCompetition(competition),
    fixtures,
    filterOptions: {
      matchweeks: distinctMatchweeks(fixtures),
      stages: distinctStages(fixtures),
      matchdays: distinctMatchweeks(fixtures),
    },
    lastUpdatedAt: maxFixtureTimestamp(detail),
  }
}

/** The 380 canonical match slugs for the Premier League, deduplicated. */
export function getStaticPremierLeagueMatchParams(): { slug: string }[] {
  return getStaticMatchParams("premier-league")
}

/** The 144 canonical match slugs for the Champions League, deduplicated. */
export function getStaticChampionsLeagueMatchParams(): { slug: string }[] {
  return getStaticMatchParams("champions-league")
}

/** Canonical match slugs for one competition, deduplicated (build fails on a duplicate). */
function getStaticMatchParams(competitionSlug: string): { slug: string }[] {
  const fixtures = getStaticFixturesForCompetition(competitionSlug)
  const seen = new Set<string>()
  const params: { slug: string }[] = []
  for (const f of fixtures) {
    const slug = buildMatchSlug(f)
    if (seen.has(slug)) throw new Error(`[static-football] duplicate match slug ${slug}`)
    seen.add(slug)
    params.push({ slug })
  }
  return params
}

export type StaticMatchResolution =
  | { kind: "ok"; data: MatchPageData }
  | { kind: "not_found" }

/**
 * Resolve a requested Premier League match slug into full detail data, or a
 * not-found result. There is no redirect: only the 380 canonical slugs are
 * generated (`dynamicParams = false`), so a non-canonical slug is a 404.
 */
export function resolveStaticMatch(slug: string, competitionSlug: string): StaticMatchResolution {
  const id = parseFixtureIdFromSlug(slug)
  if (id == null) return { kind: "not_found" }

  const staticFixture = fixtureByProviderId.get(id)
  if (!staticFixture || staticFixture.competition.slug !== competitionSlug) return { kind: "not_found" }

  const fixture = toMatchDetailFixture(staticFixture)
  if (!validateCanonicalMatchSlug(fixture, slug)) return { kind: "not_found" }

  const competitionFixtures = getStaticFixturesForCompetition(competitionSlug).map(toMatchDetailFixture)
  const homeTeamFixtures = getStaticTeamFixtures(fixture.homeTeam.id).map(toMatchDetailFixture)
  const awayTeamFixtures = getStaticTeamFixtures(fixture.awayTeam.id).map(toMatchDetailFixture)

  // Season stats are scoped to this competition, mirroring the DB path's
  // `getTeamSeasonStats` (team fixtures first, then filtered by competition).
  const competitionId = fixture.competition.id
  const homeSeasonFixtures = homeTeamFixtures.filter((f) => f.competition.id === competitionId)
  const awaySeasonFixtures = awayTeamFixtures.filter((f) => f.competition.id === competitionId)

  return {
    kind: "ok",
    data: {
      fixture,
      homeStats: computeSeasonStats(fixture.homeTeam.id, homeSeasonFixtures),
      awayStats: computeSeasonStats(fixture.awayTeam.id, awaySeasonFixtures),
      homeForm: computeRecentForm(fixture.homeTeam.id, homeTeamFixtures, fixture.kickoffAt, 5),
      awayForm: computeRecentForm(fixture.awayTeam.id, awayTeamFixtures, fixture.kickoffAt, 5),
      headToHead: computeHeadToHead(fixture.homeTeam.id, fixture.awayTeam.id, homeTeamFixtures, fixture.kickoffAt, 5),
      related: computeRelatedFixtures(fixture, competitionFixtures, 6),
    },
  }
}

// --- sitemap ----------------------------------------------------------------

/**
 * Every fixture for the sitemap, with the pieces needed to build its canonical
 * URL and priority. Iterates the static snapshot (380 Premier League + 144
 * Champions League fixtures) — no per-match N+1, no database.
 */
export function getStaticMatchesForSitemap(): MatchSitemapEntry[] {
  return staticFixtures.map((f) => ({
    competitionSlug: f.competition.slug,
    providerFixtureId: f.providerFixtureId,
    homeTeamSlug: f.homeTeam.slug,
    awayTeamSlug: f.awayTeam.slug,
    status: f.status,
    lastModified: [f.sourceUpdatedAt, f.updatedAt].filter((t): t is string => Boolean(t)).sort().pop() ?? null,
  }))
}
