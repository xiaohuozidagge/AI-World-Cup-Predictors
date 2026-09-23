import { test } from "node:test"
import assert from "node:assert/strict"

import {
  getAccuracyPageData,
  getHomePageData,
  getLatestReviews,
  getNextMatchdayPredictions,
  getPremierLeaguePageData,
  getPremierLeagueTeams,
  getSeasonSnapshot,
  getTodayPageData,
} from "./public-pages"

test("season snapshot reports the committed counts (380/330/40/10/0)", () => {
  const s = getSeasonSnapshot()
  assert.equal(s.totalFixtures, 380)
  assert.equal(s.sealedPredictions, 330)
  assert.equal(s.originalBacktests, 40)
  assert.equal(s.historicalReconstructions, 10)
  assert.equal(s.officialResults, 0)
  assert.equal(s.published, 0)
  assert.ok(s.scheduleUpdatedAt, "schedule reference date must be present")
})

test("home page data reads the static summary and never fabricates official accuracy", () => {
  const home = getHomePageData()
  assert.equal(home.snapshot.totalFixtures, 380)
  // Upcoming is drawn only from sealed predictions, never backtests.
  assert.ok(home.upcoming.length > 0)
  assert.ok(home.upcoming.every((c) => c.status === "sealed"))
  assert.ok(home.upcoming.length <= 6)
  // No field on the home summary claims an official accuracy figure.
  assert.equal(home.snapshot.officialResults, 0)
})

test("today page selects matches by snapshot date, not the browser clock", () => {
  const today = getTodayPageData()
  // The snapshot reference date is 2026-09-18; the earliest sealed matchday is
  // 2026-10-10, so the page must fall through to the next available matchday.
  assert.ok(/2026/.test(today.referenceDateLabel), "reference date label carries the year")
  assert.ok(today.matches.length > 0, "next matchday has sealed matches")
  assert.ok(today.matches.every((c) => c.status === "sealed"), "no backtests mixed into the list")
})

test("a snapshot with no matches on its date is labeled as next, not today", () => {
  const today = getTodayPageData()
  assert.equal(today.isToday, false)
  assert.equal(today.heading, "Next Football Predictions")
})

test("next matchday predictions are all sealed (no backtest treated as future)", () => {
  const next = getNextMatchdayPredictions(12)
  assert.ok(next.length > 0)
  assert.ok(next.every((c) => c.status === "sealed"))
})

test("prediction cards always carry integer percentages that sum to 100", () => {
  for (const c of [...getNextMatchdayPredictions(12), ...getLatestReviews(6)]) {
    const [h, d, a] = c.percentages
    assert.ok(Number.isInteger(h) && Number.isInteger(d) && Number.isInteger(a))
    assert.equal(h + d + a, 100)
  }
})

test("latest reviews are original backtests with a synced result only", () => {
  const reviews = getLatestReviews(6)
  assert.ok(reviews.length > 0)
  assert.ok(reviews.every((c) => c.status === "backtest"))
  assert.ok(reviews.every((c) => c.actualScore !== null))
})

test("accuracy page pins the official record to 0 / not available", () => {
  const acc = getAccuracyPageData()
  assert.equal(acc.officialPredictionCount, 0)
  assert.equal(acc.officialAccuracy, null)
  assert.equal(acc.manualAdjustments, 0)
})

test("accuracy page reports the 40-match backtest metrics (45% / 7.5% / Brier / log loss)", () => {
  const acc = getAccuracyPageData()
  assert.equal(acc.backtest.sampleSize, 40)
  assert.equal(acc.backtest.accuracy1X2, 0.45)
  assert.equal(acc.backtest.exactScoreAccuracy, 0.075)
  assert.ok(Math.abs(acc.backtest.brierScore - 0.6346927849825263) < 1e-12)
  assert.ok(Math.abs(acc.backtest.logLoss - 1.05096216010371) < 1e-12)
})

test("the 10 late backtests are not part of the 40-match metrics", () => {
  // The 40-metric sample is pinned by backtest-report.json and is independent of
  // the 10 post-event reconstructions, which are reported separately elsewhere.
  const acc = getAccuracyPageData()
  const s = getSeasonSnapshot()
  assert.equal(acc.backtest.sampleSize, 40)
  assert.equal(s.historicalReconstructions, 10)
  assert.equal(s.originalBacktests, 40)
  assert.equal(s.totalFixtures, s.sealedPredictions + s.originalBacktests + s.historicalReconstructions)
})

test("Premier League landing reports 20 teams / 380 fixtures / 330 sealed / 50 reviewed", () => {
  const pl = getPremierLeaguePageData()
  assert.equal(pl.teams.length, 20)
  assert.equal(pl.snapshot.totalFixtures, 380)
  assert.equal(pl.snapshot.sealedPredictions, 330)
  assert.equal(pl.snapshot.originalBacktests + pl.snapshot.historicalReconstructions, 50)
  assert.ok(pl.nextMatchday.every((c) => c.status === "sealed"))
  assert.ok(pl.latestReviews.every((c) => c.status === "backtest"))
})

test("team entries are unique, non-empty, and link to club pages", () => {
  const teams = getPremierLeagueTeams()
  assert.equal(teams.length, 20)
  const slugs = new Set(teams.map((t) => t.slug))
  assert.equal(slugs.size, 20)
  for (const t of teams) {
    assert.ok(t.name)
    assert.equal(t.url, `/clubs/${t.slug}`)
  }
})
