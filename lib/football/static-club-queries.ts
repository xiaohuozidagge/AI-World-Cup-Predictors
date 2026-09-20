import "server-only"

import { STATIC_DATA_AS_OF } from "./match-logic"
import {
  compareCompetitions,
  computeClubSeasonStats,
  maxClubFixtureTimestamp,
  maxCurrentSeason,
  recentClubResults,
  upcomingClubFixtures,
  type Club,
  type ClubCompetition,
  type ClubFixture,
  type ClubPageData,
} from "./club-logic"
import {
  teamsById,
  teamFixturesIndex,
  type StaticCompetition,
  type StaticFixture,
  type StaticTeam,
} from "./static-data"

// Re-export the pure club logic so the tests can import everything from a
// single entry point.
export * from "./club-logic"

/**
 * Read-only, synchronous query layer for the static club pages (Phase II). It
 * reads the validated in-memory snapshot in `./static-data.ts` and reuses the
 * pure club logic in `./club-logic.ts`. No Supabase, no data-fetching cache,
 * no `fetch`, no `await` — every function is a pure function of the snapshot,
 * so the pages it feeds can be prerendered at build time.
 */

// --- static club shapes (Club + the crest/logo URL carried as a data field) --

export interface StaticClub extends Club {
  logoUrl: string | null
}

export interface StaticClubWithCompetitions extends StaticClub {
  competitions: ClubCompetition[]
}

// --- conversion layer (Static* → Club* types, no `any`) ----------------------

export function toClub(t: StaticTeam): Club {
  return { id: t.id, name: t.name, shortName: t.shortName, slug: t.slug, country: t.country }
}

export function toClubCompetition(c: StaticCompetition): ClubCompetition {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    shortName: c.shortName,
    country: c.country,
    currentSeason: c.currentSeason,
  }
}

export function toClubFixture(f: StaticFixture): ClubFixture {
  return {
    id: f.id,
    providerFixtureId: f.providerFixtureId,
    kickoffAt: f.kickoffAt,
    status: f.status,
    stage: f.stage,
    matchweek: f.matchweek,
    season: f.season,
    homeTeam: toClub(f.homeTeam),
    awayTeam: toClub(f.awayTeam),
    homeScore: f.homeScore,
    awayScore: f.awayScore,
    competition: toClubCompetition(f.competition),
    sourceUpdatedAt: f.sourceUpdatedAt,
    updatedAt: f.updatedAt,
  }
}

// --- slug index (built once, throws on a duplicate club slug) ----------------

const clubsBySlug = new Map<string, StaticTeam>()
for (const team of teamsById.values()) {
  if (clubsBySlug.has(team.slug)) {
    throw new Error(`[static-football] duplicate club slug ${team.slug}`)
  }
  clubsBySlug.set(team.slug, team)
}

// --- queries -----------------------------------------------------------------

/** All 51 clubs (name order), each with its competition memberships and crest URL. */
export function getStaticAllClubs(): StaticClubWithCompetitions[] {
  const clubs = [...teamsById.values()].map((team) => {
    const competitions = getStaticClubCompetitionMemberships(team.id)
    return { ...toClub(team), logoUrl: team.logoUrl, competitions }
  })
  clubs.sort((a, b) => a.name.localeCompare(b.name))
  return clubs
}

/** A club by slug, or null when the slug is unknown. */
export function getStaticClubBySlug(slug: string): StaticClub | null {
  const team = clubsBySlug.get(slug)
  return team ? { ...toClub(team), logoUrl: team.logoUrl } : null
}

/** Every fixture the club plays (home or away), most recent first. */
export function getStaticClubFixtures(teamId: string): ClubFixture[] {
  return (teamFixturesIndex.get(teamId) ?? []).map(toClubFixture)
}

/** Distinct competitions the club belongs to, derived from its fixtures (PL first). */
export function getStaticClubCompetitionMemberships(teamId: string): ClubCompetition[] {
  const byId = new Map<string, ClubCompetition>()
  for (const f of teamFixturesIndex.get(teamId) ?? []) {
    if (!byId.has(f.competition.id)) byId.set(f.competition.id, toClubCompetition(f.competition))
  }
  return [...byId.values()].sort(compareCompetitions)
}

/** The 51 canonical club slugs, for `generateStaticParams`. */
export function getStaticClubParams(): { slug: string }[] {
  return [...clubsBySlug.values()].map((team) => ({ slug: team.slug }))
}

/** Full club detail data, or null for an unknown slug. */
export function getStaticClubPageData(slug: string): ClubPageData | null {
  const club = getStaticClubBySlug(slug)
  if (!club) return null

  const fixtures = getStaticClubFixtures(club.id)
  const competitions = getStaticClubCompetitionMemberships(club.id)
  const season = maxCurrentSeason(competitions)
  const inSeason = season == null ? fixtures : fixtures.filter((f) => f.season === season)

  return {
    club,
    competitions,
    stats: computeClubSeasonStats(club.id, inSeason),
    upcoming: upcomingClubFixtures(fixtures, 5, STATIC_DATA_AS_OF),
    recent: recentClubResults(fixtures, 10),
    lastUpdatedAt: maxClubFixtureTimestamp(fixtures),
    currentSeason: season,
  }
}

/** Club slugs plus their freshest fixture timestamp, for the sitemap. */
export function getStaticClubsForSitemap(): { slug: string; lastModified: string | null }[] {
  return getStaticAllClubs().map((club) => ({
    slug: club.slug,
    lastModified: maxClubFixtureTimestamp(getStaticClubFixtures(club.id)),
  }))
}
