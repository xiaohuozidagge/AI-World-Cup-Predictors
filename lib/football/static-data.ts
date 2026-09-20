import "server-only"

import type { Competition, Fixture, FixtureStatus, Team } from "@/lib/supabase/types"
import {
  FIXTURE_STATUSES,
  FINISHED_STATUSES,
  NOT_STARTED_STATUSES,
  STATIC_SCHEMA_VERSION,
  type StaticManifest,
} from "./static-types"

import competitionsJson from "@/data/football/competitions.json"
import teamsJson from "@/data/football/teams.json"
import fixturesJson from "@/data/football/fixtures.json"
import manifestJson from "@/data/football/manifest.json"

/**
 * In-memory static data layer for the football snapshot (`data/football/*.json`).
 *
 * This module imports the JSON, validates it at load time (throwing on any
 * inconsistency so a bad snapshot fails the build loudly instead of rendering a
 * half-broken page), and builds the indexes the static query layer reads from.
 * It never touches Supabase, environment variables, `fetch`, or the network —
 * the snapshot is the single source of truth for the static Premier League
 * pages.
 */

// --- enriched public shapes (camelCase + nested relationships) ---------------

export interface StaticTeam {
  id: string
  name: string
  shortName: string | null
  slug: string
  country: string | null
  logoUrl: string | null
}

export interface StaticCompetition {
  id: string
  slug: string
  name: string
  shortName: string | null
  country: string | null
  currentSeason: number | null
  logoUrl: string | null
  updatedAt: string
}

export interface StaticFixture {
  id: string
  providerFixtureId: number
  competitionId: string
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
  competition: StaticCompetition
  homeTeam: StaticTeam
  awayTeam: StaticTeam
}

// --- load-time validation ----------------------------------------------------

function fail(message: string): never {
  throw new Error(`[static-football] ${message}`)
}

function isIn<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value)
}

const competitions = competitionsJson as unknown as Competition[]
const teams = teamsJson as unknown as Team[]
const fixtures = fixturesJson as unknown as Fixture[]
export const staticManifest = manifestJson as unknown as StaticManifest

if (competitions.length === 0) fail("competitions.json is an empty array")
if (teams.length === 0) fail("teams.json is an empty array")
if (fixtures.length === 0) fail("fixtures.json is an empty array")

if (staticManifest.schemaVersion !== STATIC_SCHEMA_VERSION) {
  fail(`manifest.schemaVersion ${staticManifest.schemaVersion} != ${STATIC_SCHEMA_VERSION}`)
}

// --- enrich teams -------------------------------------------------------------

function toStaticTeam(raw: Team): StaticTeam {
  return {
    id: raw.id,
    name: raw.name,
    shortName: raw.short_name,
    slug: raw.slug,
    country: raw.country,
    logoUrl: raw.logo_url,
  }
}

const teamsById = new Map<string, StaticTeam>()
for (const raw of teams) {
  if (!raw.id) fail("team with empty id")
  if (teamsById.has(raw.id)) fail(`duplicate team id ${raw.id}`)
  teamsById.set(raw.id, toStaticTeam(raw))
}

// --- enrich competitions ------------------------------------------------------

function toStaticCompetition(raw: Competition): StaticCompetition {
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    shortName: raw.short_name,
    country: raw.country,
    currentSeason: raw.current_season,
    logoUrl: raw.logo_url,
    updatedAt: raw.updated_at,
  }
}

const competitionsById = new Map<string, StaticCompetition>()
const competitionsBySlug = new Map<string, StaticCompetition>()
for (const raw of competitions) {
  if (!raw.id) fail("competition with empty id")
  if (competitionsById.has(raw.id)) fail(`duplicate competition id ${raw.id}`)
  const enriched = toStaticCompetition(raw)
  competitionsById.set(raw.id, enriched)
  if (raw.slug) competitionsBySlug.set(raw.slug, enriched)
}

// --- enrich + validate fixtures ----------------------------------------------

const staticFixtures: StaticFixture[] = []
const fixturesByCompetitionSlug = new Map<string, StaticFixture[]>()
const fixtureByProviderId = new Map<number, StaticFixture>()
const teamFixturesIndex = new Map<string, StaticFixture[]>()

for (const raw of fixtures) {
  if (!raw.id) fail("fixture with empty id")
  if (raw.provider_fixture_id == null) fail(`fixture ${raw.id} has no provider_fixture_id`)
  if (fixtureByProviderId.has(raw.provider_fixture_id)) {
    fail(`duplicate provider_fixture_id ${raw.provider_fixture_id}`)
  }

  const competition = competitionsById.get(raw.competition_id)
  if (!competition) fail(`fixture ${raw.id} references unknown competition ${raw.competition_id}`)
  const homeTeam = teamsById.get(raw.home_team_id)
  if (!homeTeam) fail(`fixture ${raw.id} references unknown home team ${raw.home_team_id}`)
  const awayTeam = teamsById.get(raw.away_team_id)
  if (!awayTeam) fail(`fixture ${raw.id} references unknown away team ${raw.away_team_id}`)
  if (raw.home_team_id === raw.away_team_id) fail(`fixture ${raw.id} has home_team_id === away_team_id`)
  if (raw.winner_team_id != null && raw.winner_team_id !== raw.home_team_id && raw.winner_team_id !== raw.away_team_id) {
    fail(`fixture ${raw.id} winner ${raw.winner_team_id} is neither home nor away`)
  }

  if (!isIn(raw.status, FIXTURE_STATUSES)) fail(`fixture ${raw.id} has unknown status ${String(raw.status)}`)

  const anyScore =
    raw.home_score != null ||
    raw.away_score != null ||
    raw.halftime_home_score != null ||
    raw.halftime_away_score != null ||
    raw.fulltime_home_score != null ||
    raw.fulltime_away_score != null
  if (isIn(raw.status, NOT_STARTED_STATUSES) && anyScore) {
    fail(`fixture ${raw.id} is not started but carries a score`)
  }
  if (isIn(raw.status, FINISHED_STATUSES) && (raw.home_score == null || raw.away_score == null)) {
    fail(`fixture ${raw.id} is FINISHED but missing a full-time score`)
  }

  if (typeof raw.kickoff_at !== "string" || raw.kickoff_at === "" || Number.isNaN(Date.parse(raw.kickoff_at))) {
    fail(`fixture ${raw.id} has invalid kickoff_at ${String(raw.kickoff_at)}`)
  }

  const enriched: StaticFixture = {
    id: raw.id,
    providerFixtureId: raw.provider_fixture_id,
    competitionId: raw.competition_id,
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
    competition,
    homeTeam,
    awayTeam,
  }

  staticFixtures.push(enriched)

  const bySlug = fixturesByCompetitionSlug.get(competition.slug) ?? []
  bySlug.push(enriched)
  fixturesByCompetitionSlug.set(competition.slug, bySlug)

  fixtureByProviderId.set(enriched.providerFixtureId, enriched)

  for (const teamId of [enriched.homeTeam.id, enriched.awayTeam.id]) {
    const list = teamFixturesIndex.get(teamId) ?? []
    list.push(enriched)
    teamFixturesIndex.set(teamId, list)
  }
}

// Sort every index the way the query layer expects (kickoff ascending), so the
// consumers don't have to re-sort and the output is deterministic.
for (const list of fixturesByCompetitionSlug.values()) {
  list.sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt))
}
for (const list of teamFixturesIndex.values()) {
  list.sort((a, b) => b.kickoffAt.localeCompare(a.kickoffAt))
}

// --- Premier League snapshot guard (build-time stop condition) ---------------

const PREMIER_LEAGUE_SLUG = "premier-league"
const EXPECTED_PL_TEAMS = 20
const EXPECTED_PL_FIXTURES = 380

const plCompetition = competitionsBySlug.get(PREMIER_LEAGUE_SLUG)
if (!plCompetition) fail(`competition with slug ${PREMIER_LEAGUE_SLUG} not found`)
const plFixtures = fixturesByCompetitionSlug.get(PREMIER_LEAGUE_SLUG) ?? []
const plTeamIds = new Set<string>()
for (const f of plFixtures) {
  plTeamIds.add(f.homeTeam.id)
  plTeamIds.add(f.awayTeam.id)
}
if (plTeamIds.size !== EXPECTED_PL_TEAMS) {
  fail(`Premier League has ${plTeamIds.size} teams, expected ${EXPECTED_PL_TEAMS}`)
}
if (plFixtures.length !== EXPECTED_PL_FIXTURES) {
  fail(`Premier League has ${plFixtures.length} fixtures, expected ${EXPECTED_PL_FIXTURES}`)
}

// --- throw-on-missing accessors ---------------------------------------------

export function getStaticCompetition(slug: string): StaticCompetition {
  const competition = competitionsBySlug.get(slug)
  if (!competition) fail(`competition not found: ${slug}`)
  return competition
}

export function getStaticTeam(id: string): StaticTeam {
  const team = teamsById.get(id)
  if (!team) fail(`team not found: ${id}`)
  return team
}

export function getStaticFixturesForCompetition(slug: string): StaticFixture[] {
  const list = fixturesByCompetitionSlug.get(slug)
  if (!list) fail(`no fixtures for competition: ${slug}`)
  return list
}

export function getStaticFixtureByProviderId(providerFixtureId: number): StaticFixture {
  const fixture = fixtureByProviderId.get(providerFixtureId)
  if (!fixture) fail(`fixture not found for provider_fixture_id: ${providerFixtureId}`)
  return fixture
}

export function getStaticTeamFixtures(teamId: string): StaticFixture[] {
  const list = teamFixturesIndex.get(teamId)
  if (!list) fail(`no fixtures for team: ${teamId}`)
  return list
}

// Re-export the index maps for the query layer and the tests.
export { teamsById, competitionsBySlug, staticFixtures, fixturesByCompetitionSlug, fixtureByProviderId, teamFixturesIndex }
