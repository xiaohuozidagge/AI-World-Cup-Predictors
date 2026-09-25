import { test } from "node:test"
import assert from "node:assert/strict"

import {
  computeClubSeasonStats,
  type ClubFixture,
  type ClubCompetition,
} from "./club-logic"

const PL: ClubCompetition = {
  id: "comp-pl",
  slug: "premier-league",
  name: "Premier League",
  shortName: "PL",
  country: "England",
  currentSeason: 2026,
}

const CL: ClubCompetition = {
  id: "comp-cl",
  slug: "champions-league",
  name: "UEFA Champions League",
  shortName: "CL",
  country: "Europe",
  currentSeason: 2026,
}

const ARS = "team-arsenal"
const MCI = "team-man-city"
const LIV = "team-liverpool"
const CHE = "team-chelsea"

let seq = 0

function fixture(opts: {
  home: string
  away: string
  hg: number
  ag: number
  kickoffAt: string
  competition?: ClubCompetition
  status?: ClubFixture["status"]
}): ClubFixture {
  seq += 1
  const team = (id: string) => ({ id, name: id, shortName: null, slug: id, country: null })
  return {
    id: `fx-${seq}`,
    kickoffAt: opts.kickoffAt,
    status: opts.status ?? "FINISHED",
    stage: null,
    matchweek: null,
    season: 2026,
    homeTeam: team(opts.home),
    awayTeam: team(opts.away),
    homeScore: opts.hg,
    awayScore: opts.ag,
    competition: opts.competition ?? PL,
    sourceUpdatedAt: null,
    updatedAt: null,
  }
}

test("counts W/D/L and goals from the club's own perspective", () => {
  // Arsenal as the club under test.
  const fixtures = [
    // Arsenal HOME 3-1 win
    fixture({ home: ARS, away: MCI, hg: 3, ag: 1, kickoffAt: "2026-08-01T15:00:00Z" }),
    // Arsenal AWAY 0-2 loss
    fixture({ home: LIV, away: ARS, hg: 2, ag: 0, kickoffAt: "2026-08-08T15:00:00Z" }),
    // Arsenal HOME 1-1 draw
    fixture({ home: ARS, away: CHE, hg: 1, ag: 1, kickoffAt: "2026-08-15T15:00:00Z" }),
  ]

  const stats = computeClubSeasonStats(ARS, fixtures)
  const o = stats.overall

  assert.equal(o.played, 3)
  assert.equal(o.won, 1)
  assert.equal(o.drawn, 1)
  assert.equal(o.lost, 1)
  assert.equal(o.goalsFor, 4) // 3 + 0 + 1
  assert.equal(o.goalsAgainst, 4) // 1 + 2 + 1
  assert.equal(o.goalDifference, 0)

  // Home: two matches (3-1 win, 1-1 draw)
  assert.equal(o.home.played, 2)
  assert.equal(o.home.won, 1)
  assert.equal(o.home.drawn, 1)
  assert.equal(o.home.goalsFor, 4)
  assert.equal(o.home.goalsAgainst, 2)

  // Away: one match (0-2 loss)
  assert.equal(o.away.played, 1)
  assert.equal(o.away.lost, 1)
  assert.equal(o.away.goalsFor, 0)
  assert.equal(o.away.goalsAgainst, 2)
})

test("excludes non-FINISHED matches and matches with null scores", () => {
  const fixtures = [
    fixture({ home: ARS, away: MCI, hg: 2, ag: 0, kickoffAt: "2026-08-01T15:00:00Z" }),
    // Not finished — must be ignored
    fixture({ home: ARS, away: MCI, hg: 2, ag: 0, kickoffAt: "2026-08-08T15:00:00Z", status: "SCHEDULED" }),
    fixture({ home: ARS, away: MCI, hg: 2, ag: 0, kickoffAt: "2026-08-15T15:00:00Z", status: "POSTPONED" }),
    fixture({ home: ARS, away: MCI, hg: 2, ag: 0, kickoffAt: "2026-08-22T15:00:00Z", status: "LIVE" }),
  ]

  const stats = computeClubSeasonStats(ARS, fixtures)
  assert.equal(stats.overall.played, 1)
  assert.equal(stats.overall.won, 1)
})

test("a FINISHED match with a null score is not counted", () => {
  const fixtures = [
    // FINISHED but no score recorded — excluded, not guessed.
    {
      ...fixture({ home: ARS, away: MCI, hg: 0, ag: 0, kickoffAt: "2026-08-01T15:00:00Z" }),
      homeScore: null,
      awayScore: null,
    },
  ]

  const stats = computeClubSeasonStats(ARS, fixtures)
  assert.equal(stats.overall.played, 0)
})

test("form is the last 5 finished matches, most recent first", () => {
  const fixtures = [
    fixture({ home: ARS, away: MCI, hg: 1, ag: 0, kickoffAt: "2026-08-01T15:00:00Z" }), // W
    fixture({ home: ARS, away: MCI, hg: 0, ag: 1, kickoffAt: "2026-08-08T15:00:00Z" }), // L
    fixture({ home: ARS, away: MCI, hg: 1, ag: 1, kickoffAt: "2026-08-15T15:00:00Z" }), // D
    fixture({ home: ARS, away: MCI, hg: 2, ag: 0, kickoffAt: "2026-08-22T15:00:00Z" }), // W
    fixture({ home: ARS, away: MCI, hg: 0, ag: 2, kickoffAt: "2026-08-29T15:00:00Z" }), // L
    // 6th (oldest) — dropped from the last-5 form
    fixture({ home: ARS, away: MCI, hg: 3, ag: 0, kickoffAt: "2026-07-01T15:00:00Z" }), // W
  ]

  const stats = computeClubSeasonStats(ARS, fixtures)
  assert.deepEqual(stats.overall.form, ["L", "W", "D", "L", "W"])
  assert.equal(stats.overall.played, 6)
})

test("splits by competition without double-counting PL+CL clubs", () => {
  const fixtures = [
    fixture({ home: ARS, away: MCI, hg: 1, ag: 0, kickoffAt: "2026-08-01T15:00:00Z", competition: PL }),
    fixture({ home: ARS, away: LIV, hg: 2, ag: 2, kickoffAt: "2026-08-08T15:00:00Z", competition: PL }),
    fixture({ home: CHE, away: ARS, hg: 3, ag: 1, kickoffAt: "2026-08-15T15:00:00Z", competition: CL }),
  ]

  const stats = computeClubSeasonStats(ARS, fixtures)
  assert.equal(stats.overall.played, 3) // never 4+

  const bySlug = new Map(stats.byCompetition.map((e) => [e.competition.slug, e.stats]))
  assert.equal(bySlug.size, 2)
  assert.equal(bySlug.get("premier-league")?.played, 2)
  assert.equal(bySlug.get("champions-league")?.played, 1)

  // The two competition records sum back to the overall record.
  const sumPlayed = stats.byCompetition.reduce((n, e) => n + e.stats.played, 0)
  assert.equal(sumPlayed, stats.overall.played)
})

test("played always equals won + drawn + lost", () => {
  const fixtures = [
    fixture({ home: ARS, away: MCI, hg: 3, ag: 0, kickoffAt: "2026-08-01T15:00:00Z" }),
    fixture({ home: ARS, away: MCI, hg: 1, ag: 1, kickoffAt: "2026-08-08T15:00:00Z" }),
    fixture({ home: MCI, away: ARS, hg: 2, ag: 0, kickoffAt: "2026-08-15T15:00:00Z" }),
  ]
  const o = computeClubSeasonStats(ARS, fixtures).overall
  assert.equal(o.played, o.won + o.drawn + o.lost)
})
