import { test } from "node:test"
import assert from "node:assert/strict"

import {
  computeSeasonStats,
  distinctMatchweeks,
  distinctStages,
  filterFixtures,
  partitionFixtures,
  paginate,
  parsePositiveInt,
  parseWhitelistedInt,
  parseWhitelistedString,
  buildMatchTitle,
  buildMatchDescription,
  matchSitemapPriority,
  type MatchCompetition,
  type MatchDetailFixture,
  type MatchTeam,
} from "./match-logic"
import type { FixtureStatus } from "@/lib/supabase/types"

// --- fixtures ----------------------------------------------------------------

function team(id: string): MatchTeam {
  return { id, name: id, shortName: null, slug: id.toLowerCase().replace(/[^a-z0-9]+/g, "-") }
}

function competition(): MatchCompetition {
  return { id: "comp-pl", slug: "premier-league", name: "Premier League", shortName: "PL", currentSeason: 2026 }
}

let seq = 0

function fixture(opts: {
  home: string
  away: string
  hg?: number | null
  ag?: number | null
  status?: FixtureStatus
  kickoffAt?: string
  matchweek?: number | null
  stage?: string | null
}): MatchDetailFixture {
  seq += 1
  const homeTeam = team(opts.home)
  const awayTeam = team(opts.away)
  return {
    id: `fx-${seq}`,
    providerFixtureId: seq,
    competitionSlug: "premier-league",
    season: 2026,
    round: null,
    matchweek: opts.matchweek ?? null,
    stage: opts.stage ?? "REGULAR_SEASON",
    kickoffAt: opts.kickoffAt ?? "2026-08-01T15:00:00Z",
    venueName: null,
    venueCity: null,
    status: opts.status ?? "FINISHED",
    elapsedMinutes: null,
    homeScore: opts.hg ?? null,
    awayScore: opts.ag ?? null,
    halftimeHomeScore: null,
    halftimeAwayScore: null,
    fulltimeHomeScore: opts.hg ?? null,
    fulltimeAwayScore: opts.ag ?? null,
    winnerTeamId: null,
    sourceUpdatedAt: null,
    updatedAt: null,
    competition: competition(),
    homeTeam,
    awayTeam,
  }
}

// --- season stats ------------------------------------------------------------

test("computeSeasonStats counts W/D/L and goals from the team's own perspective", () => {
  const ARS = "team-arsenal"
  const fixtures = [
    fixture({ home: ARS, away: "team-mci", hg: 3, ag: 1 }), // home win
    fixture({ home: "team-liv", away: ARS, hg: 2, ag: 0 }), // away loss
    fixture({ home: ARS, away: "team-che", hg: 1, ag: 1 }), // home draw
  ]

  const stats = computeSeasonStats(ARS, fixtures)
  assert.equal(stats.played, 3)
  assert.equal(stats.won, 1)
  assert.equal(stats.drawn, 1)
  assert.equal(stats.lost, 1)
  assert.equal(stats.goalsFor, 4) // 3 + 0 + 1
  assert.equal(stats.goalsAgainst, 4) // 1 + 2 + 1
  assert.equal(stats.goalDifference, 0)
})

test("computeSeasonStats ignores non-FINISHED and null-score matches", () => {
  const ARS = "team-arsenal"
  const fixtures = [
    fixture({ home: ARS, away: "team-mci", hg: 2, ag: 0 }),
    fixture({ home: ARS, away: "team-mci", hg: 2, ag: 0, status: "SCHEDULED" }),
    fixture({ home: ARS, away: "team-mci", hg: 2, ag: 0, status: "POSTPONED" }),
    fixture({ home: ARS, away: "team-mci", hg: 2, ag: 0, status: "LIVE" }),
    fixture({ home: ARS, away: "team-mci", hg: null, ag: null, status: "FINISHED" }),
  ]
  assert.equal(computeSeasonStats(ARS, fixtures).played, 1)
})

// --- directory grouping ------------------------------------------------------

test("distinctMatchweeks returns sorted unique integers, ignoring nulls", () => {
  const fixtures = [
    fixture({ home: "a", away: "b", matchweek: 3 }),
    fixture({ home: "a", away: "b", matchweek: 1 }),
    fixture({ home: "a", away: "b", matchweek: 3 }),
    fixture({ home: "a", away: "b", matchweek: null }),
  ]
  assert.deepEqual(distinctMatchweeks(fixtures), [1, 3])
})

test("distinctStages returns sorted unique stage strings", () => {
  const fixtures = [
    fixture({ home: "a", away: "b", stage: "LEAGUE_STAGE" }),
    fixture({ home: "a", away: "b", stage: "REGULAR_SEASON" }),
    fixture({ home: "a", away: "b", stage: "LEAGUE_STAGE" }),
  ]
  assert.deepEqual(distinctStages(fixtures), ["LEAGUE_STAGE", "REGULAR_SEASON"])
})

test("filterFixtures filters by matchweek and stage independently", () => {
  const fixtures = [
    fixture({ home: "a", away: "b", matchweek: 1, stage: "REGULAR_SEASON" }),
    fixture({ home: "a", away: "b", matchweek: 2, stage: "REGULAR_SEASON" }),
    fixture({ home: "a", away: "b", matchweek: 1, stage: "LEAGUE_STAGE" }),
  ]
  assert.equal(filterFixtures(fixtures, { matchweek: 1, stage: null }).length, 2)
  assert.equal(filterFixtures(fixtures, { matchweek: null, stage: "LEAGUE_STAGE" }).length, 1)
  assert.equal(filterFixtures(fixtures, { matchweek: 2, stage: "LEAGUE_STAGE" }).length, 0)
})

test("partitionFixtures groups purely by status, ignoring kickoff time", () => {
  const fixtures = [
    fixture({ home: "a", away: "b", status: "LIVE", kickoffAt: "2026-08-10T12:00:00Z" }),
    fixture({ home: "a", away: "b", status: "HALFTIME", kickoffAt: "2026-08-10T12:00:00Z" }),
    fixture({ home: "a", away: "b", status: "FINISHED", kickoffAt: "2026-08-01T15:00:00Z" }),
    fixture({ home: "a", away: "b", status: "TIMED", kickoffAt: "2026-08-20T15:00:00Z" }),
    fixture({ home: "a", away: "b", status: "SCHEDULED", kickoffAt: "2026-08-05T15:00:00Z" }), // past date, still upcoming
    fixture({ home: "a", away: "b", status: "POSTPONED", kickoffAt: "2026-08-25T15:00:00Z" }),
    fixture({ home: "a", away: "b", status: "CANCELLED", kickoffAt: "2026-08-25T15:00:00Z" }),
  ]
  const p = partitionFixtures(fixtures)
  assert.equal(p.inProgress.length, 2) // LIVE + HALFTIME
  assert.equal(p.results.length, 1) // FINISHED
  assert.equal(p.upcoming.length, 2) // TIMED + SCHEDULED
  assert.equal(p.other.length, 2) // POSTPONED + CANCELLED
})

test("paginate slices, clamps out-of-range pages and computes totals", () => {
  const items = [1, 2, 3, 4, 5, 6, 7]
  const first = paginate(items, 1, 3)
  assert.deepEqual(first.items, [1, 2, 3])
  assert.equal(first.total, 7)
  assert.equal(first.totalPages, 3)
  assert.equal(first.page, 1)

  const last = paginate(items, 3, 3)
  assert.deepEqual(last.items, [7])
  assert.equal(last.page, 3)

  // Out-of-range clamps to the nearest valid page.
  assert.deepEqual(paginate(items, 99, 3).items, [7])
  assert.equal(paginate(items, 0, 3).page, 1)

  // Empty input still yields one (empty) page.
  assert.equal(paginate([], 1, 3).totalPages, 1)
})

// --- whitelisted query-string parsing ---------------------------------------

test("parsePositiveInt accepts only positive integer strings", () => {
  assert.equal(parsePositiveInt("5"), 5)
  assert.equal(parsePositiveInt("0"), null)
  assert.equal(parsePositiveInt("-1"), null)
  assert.equal(parsePositiveInt("abc"), null)
  assert.equal(parsePositiveInt("1.5"), null)
  assert.equal(parsePositiveInt(undefined), null)
  assert.equal(parsePositiveInt(["7"]), 7)
})

test("parseWhitelistedInt and parseWhitelistedString only accept allowed values", () => {
  assert.equal(parseWhitelistedInt("3", [1, 3, 5]), 3)
  assert.equal(parseWhitelistedInt("4", [1, 3, 5]), null)
  assert.equal(parseWhitelistedString("LEAGUE_STAGE", ["LEAGUE_STAGE"]), "LEAGUE_STAGE")
  assert.equal(parseWhitelistedString("REGULAR_SEASON", ["LEAGUE_STAGE"]), null)
  assert.equal(parseWhitelistedString(undefined, ["LEAGUE_STAGE"]), null)
})

// --- metadata ----------------------------------------------------------------

test("buildMatchTitle uses result phrasing when finished, date/time otherwise", () => {
  const finished = fixture({ home: "Arsenal", away: "Liverpool", hg: 2, ag: 1, status: "FINISHED", kickoffAt: "2026-08-15T17:30:00Z" })
  assert.equal(buildMatchTitle(finished), "Arsenal vs Liverpool Result & Score")

  const upcoming = fixture({ home: "Arsenal", away: "Liverpool", status: "TIMED", kickoffAt: "2026-08-15T17:30:00Z" })
  assert.equal(buildMatchTitle(upcoming), "Arsenal vs Liverpool: Aug 15, 2026 & 5:30 PM UTC")
})

test("buildMatchDescription includes names and never uses forbidden prediction wording", () => {
  const f = fixture({ home: "Arsenal", away: "Liverpool", hg: 2, ag: 1, status: "FINISHED", kickoffAt: "2026-08-15T17:30:00Z" })
  const description = buildMatchDescription(f)
  assert.match(description, /Arsenal/)
  assert.match(description, /Liverpool/)
  assert.match(description, /2-1/)
  for (const banned of ["prediction", "odds", "live score", "win probability", "predicted score"]) {
    assert.doesNotMatch(description.toLowerCase(), new RegExp(banned))
  }
})

// --- sitemap priority --------------------------------------------------------

test("matchSitemapPriority maps finished/future/cancelled to 0.6/0.7/0.3", () => {
  assert.equal(matchSitemapPriority("FINISHED"), 0.6)
  assert.equal(matchSitemapPriority("SCHEDULED"), 0.7)
  assert.equal(matchSitemapPriority("TIMED"), 0.7)
  assert.equal(matchSitemapPriority("LIVE"), 0.7)
  assert.equal(matchSitemapPriority("POSTPONED"), 0.3)
  assert.equal(matchSitemapPriority("CANCELLED"), 0.3)
  assert.equal(matchSitemapPriority("SUSPENDED"), 0.3)
})
