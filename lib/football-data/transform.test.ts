import { test } from "node:test"
import assert from "node:assert/strict"

import type { Competition, Match, Season, Team } from "./types"
import {
  buildTeamSlug,
  competitionSlug,
  expectedCompetitionName,
  resolveTeamSlug,
  seasonStartYear,
  toCompetitionRow,
  toFixtureRow,
  toTeamRow,
} from "./transform"

const area = { id: 2072, name: "England", code: "ENG" }

function makeSeason(startDate: string): Season {
  return { id: 1, startDate, endDate: "2026-05-24", currentMatchday: 4, winner: null }
}

function makeCompetition(overrides: Partial<Competition> = {}): Competition {
  return {
    id: 2021,
    name: "Premier League",
    code: "PL",
    type: "LEAGUE",
    emblem: "https://crests/PL.png",
    area,
    currentSeason: makeSeason("2025-08-16"),
    lastUpdated: "2025-09-01T00:00:00Z",
    ...overrides,
  }
}

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 57,
    name: "Arsenal FC",
    shortName: "Arsenal",
    tla: "ARS",
    crest: "https://crests/57.png",
    area,
    venue: "Emirates Stadium",
    lastUpdated: "2025-09-01T00:00:00Z",
    ...overrides,
  }
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 1001,
    utcDate: "2025-08-16T14:00:00Z",
    status: "FINISHED",
    matchday: 1,
    stage: "REGULAR_SEASON",
    group: null,
    lastUpdated: "2025-09-01T00:00:00Z",
    homeTeam: { id: 57, name: "Arsenal FC", shortName: "Arsenal", tla: "ARS", crest: null },
    awayTeam: { id: 65, name: "Manchester City FC", shortName: "Man City", tla: "MCI", crest: null },
    score: {
      winner: "HOME_TEAM",
      duration: "REGULAR",
      fullTime: { home: 2, away: 1 },
      halfTime: { home: 1, away: 0 },
    },
    ...overrides,
  }
}

// --- season -------------------------------------------------------------------

test("seasonStartYear takes the calendar year of the season start date", () => {
  assert.equal(seasonStartYear(makeSeason("2025-08-16")), 2025)
  assert.equal(seasonStartYear(makeSeason("2026-07-08")), 2026)
  assert.equal(seasonStartYear(null), null)
  assert.equal(seasonStartYear(undefined), null)
})

// --- competition ---------------------------------------------------------------

test("toCompetitionRow uses API name/type/emblem plus fixed slug/short_name/country", () => {
  const row = toCompetitionRow(makeCompetition(), "PL")
  assert.equal(row.provider, "football-data.org")
  assert.equal(row.provider_competition_id, 2021)
  assert.equal(row.slug, "premier-league")
  assert.equal(row.name, "Premier League")
  assert.equal(row.short_name, "Premier League")
  assert.equal(row.country, "England")
  assert.equal(row.competition_type, "LEAGUE")
  assert.equal(row.current_season, 2025)
  assert.equal(row.logo_url, "https://crests/PL.png")
  assert.equal(row.is_active, true)
})

test("competition slug and expected name are fixed per code", () => {
  assert.equal(competitionSlug("PL"), "premier-league")
  assert.equal(expectedCompetitionName("PL"), "Premier League")
})

// --- teams ---------------------------------------------------------------------

test("buildTeamSlug lowercases, strips accents and punctuation", () => {
  assert.equal(buildTeamSlug("Arsenal FC", 57), "arsenal-fc")
  assert.equal(buildTeamSlug("Paris Saint-Germain", 524), "paris-saint-germain")
  assert.equal(buildTeamSlug("FC Bayern München", 5), "fc-bayern-munchen")
  assert.equal(buildTeamSlug("   ", 999), "team-999")
})

test("resolveTeamSlug keeps a free slug and appends the team id on collision", () => {
  const used = new Set<string>(["arsenal"])
  assert.equal(resolveTeamSlug("arsenal", 57, used), "arsenal-57")
  assert.equal(resolveTeamSlug("chelsea", 61, used), "chelsea")
  assert.ok(used.has("arsenal-57"))
})

test("toTeamRow maps fields and prefers shortName over tla", () => {
  const row = toTeamRow(makeTeam(), "arsenal")
  assert.equal(row.provider_team_id, 57)
  assert.equal(row.name, "Arsenal FC")
  assert.equal(row.short_name, "Arsenal")
  assert.equal(row.country, "England")
  assert.equal(row.logo_url, "https://crests/57.png")

  const noShort = toTeamRow(makeTeam({ shortName: null, tla: "ARS" }), "arsenal")
  assert.equal(noShort.short_name, "ARS")
})

// --- fixtures ------------------------------------------------------------------

const ctx = { season: 2025, competitionId: "comp-uuid", homeTeamId: "home-uuid", awayTeamId: "away-uuid" }

test("toFixtureRow maps a finished match with scores and winner", () => {
  const { row, statusRecognized } = toFixtureRow({ match: makeMatch(), ...ctx })
  assert.equal(statusRecognized, true)
  assert.equal(row.status, "FINISHED")
  assert.equal(row.home_score, 2)
  assert.equal(row.away_score, 1)
  assert.equal(row.halftime_home_score, 1)
  assert.equal(row.halftime_away_score, 0)
  assert.equal(row.winner_team_id, "home-uuid")
  assert.equal(row.matchweek, 1)
  assert.equal(row.stage, "REGULAR_SEASON")
  assert.equal(row.round, null)
})

test("toFixtureRow maps away win and draw winner rules", () => {
  const awayWin = toFixtureRow({
    match: makeMatch({ score: { winner: "AWAY_TEAM", duration: "REGULAR", fullTime: { home: 0, away: 1 }, halfTime: { home: 0, away: 1 } } }),
    ...ctx,
  })
  assert.equal(awayWin.row.winner_team_id, "away-uuid")

  const draw = toFixtureRow({
    match: makeMatch({ score: { winner: "DRAW", duration: "REGULAR", fullTime: { home: 1, away: 1 }, halfTime: { home: 0, away: 0 } } }),
    ...ctx,
  })
  assert.equal(draw.row.winner_team_id, null)
})

test("toFixtureRow leaves scores null for scheduled / postponed / cancelled matches", () => {
  for (const status of ["SCHEDULED", "TIMED", "POSTPONED", "CANCELLED"]) {
    const { row } = toFixtureRow({
      match: makeMatch({
        status,
        score: { winner: null, duration: "REGULAR", fullTime: { home: null, away: null }, halfTime: { home: null, away: null } },
      }),
      ...ctx,
    })
    assert.equal(row.home_score, null, `${status} home_score should be null`)
    assert.equal(row.away_score, null, `${status} away_score should be null`)
    assert.equal(row.winner_team_id, null)
  }
})

test("toFixtureRow maps status codes through the football-data.org map", () => {
  assert.equal(toFixtureRow({ match: makeMatch({ status: "IN_PLAY" }), ...ctx }).row.status, "LIVE")
  assert.equal(toFixtureRow({ match: makeMatch({ status: "PAUSED" }), ...ctx }).row.status, "HALFTIME")
  assert.equal(toFixtureRow({ match: makeMatch({ status: "AWARDED" }), ...ctx }).row.status, "FINISHED")
  assert.equal(toFixtureRow({ match: makeMatch({ status: "SUSPENDED" }), ...ctx }).row.status, "SUSPENDED")
})

test("toFixtureRow flags unknown status and keeps status null", () => {
  const { row, statusRecognized } = toFixtureRow({ match: makeMatch({ status: "WEIRD" }), ...ctx })
  assert.equal(statusRecognized, false)
  assert.equal(row.status, null)
})

test("toFixtureRow does not guess a winner from a null score.winner", () => {
  const { row } = toFixtureRow({
    match: makeMatch({
      status: "FINISHED",
      score: { winner: null, duration: "REGULAR", fullTime: { home: 3, away: 0 }, halfTime: { home: 2, away: 0 } },
    }),
    ...ctx,
  })
  assert.equal(row.home_score, 3)
  assert.equal(row.winner_team_id, null)
})
