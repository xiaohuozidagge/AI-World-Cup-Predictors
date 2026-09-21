import { test } from "node:test"
import assert from "node:assert/strict"

import {
  ALL_FEATURE_NAMES,
  computeNoPriorSeasonLookup,
  computeStandardization,
  extractFeatureVector,
  featureNamesFor,
  featureSetSize,
  initFeatureState,
  NEUTRAL_ABS_GOAL_DIFF,
  NEUTRAL_DRAW_RATE,
  NEUTRAL_GOALS_FOR,
  NEUTRAL_TOTAL_GOALS,
  recordMatchToFeatureState,
  standardizeFeatures,
  type DrawFeatureContext,
  type FeatureState,
} from "./features"
import type { ModelMatch } from "./types"

function mm(id: string, season: string, date: string, homeSlug: string, awaySlug: string, hg: number, ag: number): ModelMatch {
  return { id, season, date, homeSlug, awaySlug, homeGoals: hg, awayGoals: ag }
}

function ctx(state: FeatureState, overrides: Partial<DrawFeatureContext> = {}): DrawFeatureContext {
  return {
    eloHome: 1600,
    eloAway: 1500,
    lambdaHome: 1.6,
    lambdaAway: 1.1,
    baseDrawProbability: 0.25,
    homeCoverage: 20,
    awayCoverage: 20,
    homeState: state.teams.alpha,
    awayState: state.teams.beta,
    noPriorSeason: new Set<string>(),
    homeSlug: "alpha",
    awaySlug: "beta",
    ...overrides,
  }
}

test("feature set sizes and names are the pre-registered 6/15/23 prefix", () => {
  assert.equal(featureSetSize("A"), 6)
  assert.equal(featureSetSize("B"), 15)
  assert.equal(featureSetSize("C"), 23)
  assert.equal(ALL_FEATURE_NAMES.length, 23)
  assert.deepEqual(featureNamesFor("A"), ALL_FEATURE_NAMES.slice(0, 6))
  assert.deepEqual(featureNamesFor("C"), ALL_FEATURE_NAMES.slice(0, 23))
})

test("recordMatchToFeatureState keeps only the last 5 and tracks season aggregates", () => {
  const s = initFeatureState()
  for (let i = 1; i <= 7; i++) {
    recordMatchToFeatureState(s, mm(`m${i}`, "2022-23", `2022-08-${10 + i}`, "alpha", "beta", 1, 0))
  }
  const alpha = s.teams.alpha
  assert.equal(alpha.recent.length, 5)
  assert.equal(alpha.recent[0].date, "2022-08-17") // most recent first
  assert.equal(alpha.recent[0].goalsFor, 1)
  assert.equal(alpha.seasonMatches, 7)
  assert.equal(alpha.seasonFor, 7)
  assert.equal(alpha.seasonAgainst, 0)
})

test("recent-5 features use only pre-match data — the match's own result is excluded", () => {
  const s = initFeatureState()
  // Warm the team with 5 prior matches, all draws with 2 total goals each.
  for (let i = 0; i < 5; i++) {
    recordMatchToFeatureState(s, mm(`p${i}`, "2022-23", `2022-09-${1 + i}`, "alpha", "beta", 1, 1))
  }
  // Extract features for the next match BEFORE recording it.
  const before = ctx(s)
  const v = extractFeatureVector(before, "B")
  // Feature index 6 = homeRecentDrawRate (B includes recent). Should be 1.0 from the 5 draws.
  assert.equal(v[6], 1)
  // The upcoming match (alpha wins 5-0) must not affect the pre-match features:
  recordMatchToFeatureState(s, mm("upcoming", "2022-23", "2022-10-01", "alpha", "beta", 5, 0))
  const after = ctx(s)
  const v2 = extractFeatureVector(after, "B")
  assert.equal(v2[6], 0.8) // now 4 of the last 5 are draws
  assert.equal(v[6], 1) // the pre-match vector is unchanged
})

test("no-history teams use explicit league-neutral defaults, not future means", () => {
  const s = initFeatureState()
  const c = ctx(s, { noPriorSeason: new Set(["alpha", "beta"]) }) // alpha/beta have no state
  const v = extractFeatureVector(c, "C")
  // recent draw rate neutral, total goals neutral, abs diff neutral
  assert.equal(v[6], NEUTRAL_DRAW_RATE)
  assert.equal(v[9], NEUTRAL_TOTAL_GOALS)
  assert.equal(v[12], NEUTRAL_ABS_GOAL_DIFF)
  // season-to-date goals neutral
  assert.equal(v[15], NEUTRAL_GOALS_FOR)
  // both teams have < 5 season matches → insufficient sample flag; no prior → flag
  assert.equal(v[21], 1)
  assert.equal(v[22], 1)
})

test("standardization statistics come only from the supplied training rows", () => {
  const train = [
    [0, 10],
    [2, 20],
    [4, 30],
  ]
  const p = computeStandardization(train)
  // means from training only
  assert.ok(Math.abs(p.means[0] - 2) < 1e-12)
  assert.ok(Math.abs(p.means[1] - 20) < 1e-12)
  // a held-out row is standardized with training stats, independent of its own scale
  const held = standardizeFeatures([[100, 0]], p)
  assert.ok(Math.abs(held[0][0] - (100 - 2) / Math.sqrt((4 + 0 + 4) / 3)) < 1e-12)
})

test("computeNoPriorSeasonLookup flags only teams new to the dataset", () => {
  const matches = [
    mm("a1", "2021-22", "2021-08-13", "alpha", "beta", 1, 0),
    mm("a2", "2022-23", "2022-08-13", "alpha", "beta", 1, 0),
    mm("a3", "2022-23", "2022-08-13", "gamma", "alpha", 0, 0), // gamma is promoted
  ]
  const lookup = computeNoPriorSeasonLookup(matches)
  assert.ok(lookup["2021-22"].has("alpha"))
  assert.ok(lookup["2021-22"].has("beta"))
  assert.ok(!lookup["2022-23"].has("alpha"))
  assert.ok(lookup["2022-23"].has("gamma")) // no 2021-22 matches
})

test("insufficient-sample flag clears once both teams have ≥5 season matches", () => {
  const s = initFeatureState()
  for (let i = 0; i < 5; i++) {
    recordMatchToFeatureState(s, mm(`m${i}`, "2022-23", `2022-08-${10 + i}`, "alpha", "beta", 1, 1))
  }
  const v = extractFeatureVector(ctx(s), "C")
  assert.equal(v[21], 0) // both have 5 matches
})
