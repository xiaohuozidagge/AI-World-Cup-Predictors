import { mapFixtureStatus } from "../football/status-map"
import type { FixtureStatus } from "../supabase/types"

import type { Area, Competition, Match, Season, Team, TeamRef } from "./types"

/**
 * Pure transformations from football-data.org v4 shapes to normalized records.
 *
 * Everything here is a plain function with no I/O, so it can be unit-tested in
 * isolation.
 */

export const PROVIDER = "football-data.org"

// --- competition metadata -----------------------------------------------------

export interface CompetitionMeta {
  slug: string
  shortName: string
  country: string
  expectedName: string
}

const COMPETITION_META: Record<"PL", CompetitionMeta> = {
  PL: {
    slug: "premier-league",
    shortName: "Premier League",
    country: "England",
    expectedName: "Premier League",
  },
}

export function competitionMeta(code: "PL"): CompetitionMeta {
  return COMPETITION_META[code]
}

export function competitionSlug(code: "PL"): string {
  return COMPETITION_META[code].slug
}

export function expectedCompetitionName(code: "PL"): string {
  return COMPETITION_META[code].expectedName
}

// --- insert rows --------------------------------------------------------------

export interface CompetitionRow {
  provider: string
  provider_competition_id: number
  slug: string
  name: string
  short_name: string | null
  country: string | null
  competition_type: string | null
  current_season: number | null
  logo_url: string | null
  is_active: boolean
}

export interface TeamRow {
  provider: string
  provider_team_id: number
  name: string
  short_name: string | null
  slug: string
  country: string | null
  logo_url: string | null
}

export interface FixtureRow {
  provider: string
  provider_fixture_id: number
  competition_id: string
  season: number
  round: string | null
  matchweek: number | null
  stage: string | null
  home_team_id: string
  away_team_id: string
  kickoff_at: string
  venue_name: string | null
  venue_city: string | null
  status: FixtureStatus | null
  elapsed_minutes: number | null
  home_score: number | null
  away_score: number | null
  halftime_home_score: number | null
  halftime_away_score: number | null
  fulltime_home_score: number | null
  fulltime_away_score: number | null
  winner_team_id: string | null
  source_updated_at: string | null
}

// --- season -------------------------------------------------------------------

/** Season year is the calendar year in which the season starts (never hardcoded). */
export function seasonStartYear(season: Season | null | undefined): number | null {
  if (!season?.startDate) return null
  const year = Number(season.startDate.slice(0, 4))
  return Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null
}

// --- competitions -------------------------------------------------------------

export function toCompetitionRow(competition: Competition, code: "PL"): CompetitionRow {
  const meta = COMPETITION_META[code]
  return {
    provider: PROVIDER,
    provider_competition_id: competition.id,
    slug: meta.slug,
    name: competition.name,
    short_name: meta.shortName,
    country: meta.country,
    competition_type: competition.type || null,
    current_season: seasonStartYear(competition.currentSeason),
    logo_url: competition.emblem || null,
    is_active: true,
  }
}

// --- teams --------------------------------------------------------------------

/** Stable, deterministic base slug from a team name. Accents and punctuation are stripped. */
export function buildTeamSlug(name: string, providerTeamId: number): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return base || `team-${providerTeamId}`
}

/**
 * Resolve a team slug against the slugs already in use, appending the provider
 * team id on collision (per spec). Mutates `used` so the next team sees it.
 */
export function resolveTeamSlug(base: string, providerTeamId: number, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  const fallback = `${base}-${providerTeamId}`
  used.add(fallback)
  return fallback
}

/** Minimal structural team shape accepted by toTeamRow (full Team or match TeamRef). */
export interface TeamInput {
  id: number
  name: string
  shortName: string | null
  tla: string | null
  crest: string | null
  area?: Area | null
}

export function toTeamRow(team: TeamInput, slug: string): TeamRow {
  return {
    provider: PROVIDER,
    provider_team_id: team.id,
    name: team.name,
    short_name: team.shortName || team.tla || null,
    slug,
    country: team.area?.name ?? null,
    logo_url: team.crest || null,
  }
}

// --- fixtures -----------------------------------------------------------------

export interface FixtureTransformInput {
  match: Match
  season: number
  competitionId: string
  homeTeamId: string
  awayTeamId: string
}

export interface FixtureTransformResult {
  statusRecognized: boolean
  row: FixtureRow
}

export function toFixtureRow(input: FixtureTransformInput): FixtureTransformResult {
  const { match, season, competitionId, homeTeamId, awayTeamId } = input
  const statusResult = mapFixtureStatus(match.status)

  // Only finished / awarded matches carry a score; never fabricate a 0-0 for
  // scheduled, postponed or cancelled matches, and never coerce null to 0.
  const finished = match.status === "FINISHED" || match.status === "AWARDED"
  const fullTime = finished ? match.score?.fullTime : null
  const halfTime = finished ? match.score?.halfTime : null

  // Winner comes only from the API's explicit score.winner — never inferred
  // from the scoreline.
  const winner = match.score?.winner ?? null
  const winnerTeamId =
    winner === "HOME_TEAM" ? homeTeamId : winner === "AWAY_TEAM" ? awayTeamId : null

  return {
    statusRecognized: statusResult.recognized,
    row: {
      provider: PROVIDER,
      provider_fixture_id: match.id,
      competition_id: competitionId,
      season,
      round: match.group || null,
      matchweek: match.matchday ?? null,
      stage: match.stage || null,
      home_team_id: homeTeamId,
      away_team_id: awayTeamId,
      kickoff_at: match.utcDate,
      venue_name: null,
      venue_city: null,
      status: statusResult.status,
      elapsed_minutes: null,
      home_score: fullTime?.home ?? null,
      away_score: fullTime?.away ?? null,
      halftime_home_score: halfTime?.home ?? null,
      halftime_away_score: halfTime?.away ?? null,
      fulltime_home_score: fullTime?.home ?? null,
      fulltime_away_score: fullTime?.away ?? null,
      winner_team_id: winnerTeamId,
      source_updated_at: match.lastUpdated || null,
    },
  }
}

// Re-export the team types for callers that collect teams from both sources.
export type { Team, TeamRef }
