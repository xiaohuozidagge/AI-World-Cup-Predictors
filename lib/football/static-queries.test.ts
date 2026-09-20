import { test } from "node:test"
import assert from "node:assert/strict"

import {
  computeRecentForm,
  getStaticCompetitionPageData,
  getStaticMatchDirectoryData,
  getStaticPremierLeagueMatchParams,
  resolveStaticMatch,
  toMatchDetailFixture,
} from "./static-queries"
import {
  competitionsBySlug,
  staticFixtures,
  staticManifest,
  teamsById,
} from "./static-data"

const PL = "premier-league"

// (1) find premier-league -----------------------------------------------------

test("getStaticCompetitionPageData finds the premier-league competition", () => {
  const data = getStaticCompetitionPageData(PL)
  assert.equal(data.competition.slug, PL)
  assert.equal(data.competition.name, "Premier League")
})

// (2) 20 unique teams ---------------------------------------------------------

test("premier-league has exactly 20 unique teams", () => {
  const data = getStaticCompetitionPageData(PL)
  assert.equal(data.stats.teamCount, 20)
})

// (3) 380 fixtures ------------------------------------------------------------

test("premier-league has exactly 380 fixtures", () => {
  const data = getStaticCompetitionPageData(PL)
  assert.equal(data.stats.totalFixtures, 380)
})

// (4) 380 unique canonical slugs ----------------------------------------------

test("generateStaticParams yields 380 unique canonical slugs", () => {
  const params = getStaticPremierLeagueMatchParams()
  assert.equal(params.length, 380)
  assert.equal(new Set(params.map((p) => p.slug)).size, 380)
})

// (5) provider id resolves ----------------------------------------------------

test("a canonical slug resolves to its static fixture", () => {
  const data = getStaticMatchDirectoryData(PL)
  const first = data.fixtures[0]
  assert.ok(first.providerFixtureId != null)
  const slug = `${first.homeTeam.slug}-vs-${first.awayTeam.slug}-${first.providerFixtureId}`
  const res = resolveStaticMatch(slug, PL)
  assert.equal(res.kind, "ok")
  if (res.kind !== "ok") return
  assert.equal(res.data.fixture.id, first.id)
})

// (6) home/away team names resolve from the index -----------------------------

test("home and away team names resolve from the teams index", () => {
  const data = getStaticMatchDirectoryData(PL)
  for (const f of data.fixtures.slice(0, 5)) {
    const home = teamsById.get(f.homeTeam.id)
    const away = teamsById.get(f.awayTeam.id)
    assert.ok(home, `missing home team ${f.homeTeam.id}`)
    assert.ok(away, `missing away team ${f.awayTeam.id}`)
    assert.equal(home.name, f.homeTeam.name)
    assert.equal(away.name, f.awayTeam.name)
  }
})

// (7) Upcoming has no FINISHED ------------------------------------------------

test("upcoming fixtures contain no FINISHED matches", () => {
  const data = getStaticCompetitionPageData(PL)
  assert.ok(data.upcoming.length > 0)
  for (const f of data.upcoming) assert.notEqual(f.status, "FINISHED")
})

// (8) Results only FINISHED ---------------------------------------------------

test("recent results contain only FINISHED matches", () => {
  const data = getStaticCompetitionPageData(PL)
  assert.ok(data.recent.length > 0)
  for (const f of data.recent) assert.equal(f.status, "FINISHED")
})

// (9) not-started scores null -------------------------------------------------

test("not-started fixtures carry no scores", () => {
  const data = getStaticMatchDirectoryData(PL)
  const notStarted = data.fixtures.filter((f) => f.status === "SCHEDULED" || f.status === "TIMED")
  assert.ok(notStarted.length > 0)
  for (const f of notStarted) {
    assert.equal(f.homeScore, null)
    assert.equal(f.awayScore, null)
  }
})

// (10) recent form has no fixture at/after kickoff ----------------------------

test("recent form contains only matches strictly before kickoff", () => {
  const data = getStaticMatchDirectoryData(PL)
  const finished = data.fixtures.filter((f) => f.status === "FINISHED")
  assert.ok(finished.length > 0)
  for (const target of finished) {
    const teamFixtures = staticFixtures
      .filter((f) => f.homeTeam.id === target.homeTeam.id || f.awayTeam.id === target.homeTeam.id)
      .map(toMatchDetailFixture)
    for (const e of computeRecentForm(target.homeTeam.id, teamFixtures, target.kickoffAt, 5)) {
      assert.ok(new Date(e.kickoffAt).getTime() < new Date(target.kickoffAt).getTime())
    }
  }
})

// (11) season stats use each team's own goals for/against ---------------------

test("season stats use each team's own goals for/against direction", () => {
  const data = getStaticMatchDirectoryData(PL)
  const target = data.fixtures.find((f) => f.status === "FINISHED")
  assert.ok(target)
  assert.ok(target.providerFixtureId != null)
  const slug = `${target.homeTeam.slug}-vs-${target.awayTeam.slug}-${target.providerFixtureId}`
  const res = resolveStaticMatch(slug, PL)
  assert.equal(res.kind, "ok")
  if (res.kind !== "ok") return

  const homeId = target.homeTeam.id
  const awayId = target.awayTeam.id

  // Hand-compute each team's goals for/against over FINISHED PL fixtures.
  let homeGF = 0
  let homeGA = 0
  let awayGF = 0
  let awayGA = 0
  for (const f of staticFixtures) {
    if (f.competition.slug !== PL) continue
    if (f.status !== "FINISHED" || f.homeScore == null || f.awayScore == null) continue
    if (f.homeTeam.id === homeId) {
      homeGF += f.homeScore
      homeGA += f.awayScore
    } else if (f.awayTeam.id === homeId) {
      homeGF += f.awayScore
      homeGA += f.homeScore
    }
    if (f.homeTeam.id === awayId) {
      awayGF += f.homeScore
      awayGA += f.awayScore
    } else if (f.awayTeam.id === awayId) {
      awayGF += f.awayScore
      awayGA += f.homeScore
    }
  }

  assert.equal(res.data.homeStats.goalsFor, homeGF)
  assert.equal(res.data.homeStats.goalsAgainst, homeGA)
  assert.equal(res.data.awayStats.goalsFor, awayGF)
  assert.equal(res.data.awayStats.goalsAgainst, awayGA)
})

// (12) H2H only real meetings between the two teams ---------------------------

test("head-to-head contains only real meetings between the two teams", () => {
  const data = getStaticMatchDirectoryData(PL)
  const finished = data.fixtures.filter((f) => f.status === "FINISHED")
  assert.ok(finished.length > 0)
  const target = finished[finished.length - 1]
  assert.ok(target.providerFixtureId != null)
  const slug = `${target.homeTeam.slug}-vs-${target.awayTeam.slug}-${target.providerFixtureId}`
  const res = resolveStaticMatch(slug, PL)
  assert.equal(res.kind, "ok")
  if (res.kind !== "ok") return

  const homeId = target.homeTeam.id
  const awayId = target.awayTeam.id
  for (const h of res.data.headToHead) {
    const teams = [h.homeTeam.id, h.awayTeam.id].sort()
    assert.deepEqual(teams, [homeId, awayId].sort())
  }

  // Every prior finished meeting between the two teams (across competitions)
  // must appear, capped at the same limit the page uses.
  const prior = staticFixtures
    .filter((f) => f.status === "FINISHED" && f.homeScore != null && f.awayScore != null)
    .filter((f) => new Date(f.kickoffAt).getTime() < new Date(target.kickoffAt).getTime())
    .filter(
      (f) =>
        (f.homeTeam.id === homeId && f.awayTeam.id === awayId) ||
        (f.homeTeam.id === awayId && f.awayTeam.id === homeId),
    )
  assert.equal(res.data.headToHead.length, Math.min(prior.length, 5))
})

// (13) related excludes the current fixture -----------------------------------

test("related fixtures exclude the current fixture", () => {
  const data = getStaticMatchDirectoryData(PL)
  const target = data.fixtures[0]
  assert.ok(target.providerFixtureId != null)
  const slug = `${target.homeTeam.slug}-vs-${target.awayTeam.slug}-${target.providerFixtureId}`
  const res = resolveStaticMatch(slug, PL)
  assert.equal(res.kind, "ok")
  if (res.kind !== "ok") return
  assert.ok(res.data.related.length > 0)
  for (const f of res.data.related) assert.notEqual(f.id, target.id)
})

// (14) unknown id → not_found -------------------------------------------------

test("an unknown provider id resolves to not_found", () => {
  const res = resolveStaticMatch("arsenal-fc-vs-chelsea-fc-999999999", PL)
  assert.equal(res.kind, "not_found")
})

// (15) wrong team text + correct id → not_found / single canonical slug -------

test("a non-canonical slug with the correct id resolves to not_found", () => {
  const data = getStaticMatchDirectoryData(PL)
  const f = data.fixtures[0]
  assert.ok(f.providerFixtureId != null)
  const canonical = `${f.homeTeam.slug}-vs-${f.awayTeam.slug}-${f.providerFixtureId}`
  const wrong = `wrong-home-vs-wrong-away-${f.providerFixtureId}`

  assert.equal(resolveStaticMatch(wrong, PL).kind, "not_found")
  assert.equal(resolveStaticMatch(canonical, PL).kind, "ok")
})

// (16) loaded counts match manifest.json --------------------------------------

test("loaded static counts match manifest.json", () => {
  const plManifest = staticManifest.competitions.find((c) => c.slug === PL)
  assert.ok(plManifest)
  const data = getStaticCompetitionPageData(PL)

  assert.equal(staticManifest.counts.competitions, competitionsBySlug.size)
  assert.equal(staticManifest.counts.teams, teamsById.size)
  assert.equal(staticManifest.counts.fixtures, staticFixtures.length)

  assert.equal(plManifest.teams, data.stats.teamCount)
  assert.equal(plManifest.fixtures, data.stats.totalFixtures)
  assert.equal(plManifest.finishedFixtures, data.stats.finishedFixtures)
  assert.equal(plManifest.upcomingFixtures, data.stats.upcomingFixtures)
})
