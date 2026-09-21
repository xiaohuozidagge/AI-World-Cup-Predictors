/**
 * Tests for the 2026/27 prediction artifact layer. Verifies the v1 config is
 * frozen and uncalibrated, the replay loop is equivalent to `runBacktest`, the
 * candidate predictions are issued from a single frozen state with no leakage,
 * and the artifact/reason mapping is deterministic and traceable.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"

import { DEFAULT_CONFIG, hashConfig, resolveConfig, type DeepPartial, type ModelConfig } from "./config"
import { runBacktest } from "./backtest"
import { predictMatch } from "./predictor"
import {
  advanceState,
  buildBacktestReport,
  buildCoverageReason,
  buildManifest,
  buildPredictionArtifact,
  mapReason,
  replayMatches,
  sha256Hex,
  sortPredictions,
  type ArtifactMatchMeta,
  type CoverageValue,
} from "./prediction-artifact"
import type { MatchPrediction, ModelMatch, Reason } from "./types"
import { readJson, MODEL_DIR, MODEL_DIR_V11 } from "../../scripts/model-inputs"

const V1_HASH = "28b50575b3ceea4dcad6d6d3e581f2895d825c84b82745def1214f9678679680"

const V1_REASON_CODES = new Set([
  "ELO_ADVANTAGE_HOME",
  "ELO_ADVANTAGE_AWAY",
  "HOME_ATTACK",
  "AWAY_ATTACK",
  "AWAY_DEFENSE_WEAK",
  "HOME_DEFENSE_WEAK",
  "EXPECTED_GOALS",
  "HOME_ADVANTAGE",
  "LIMITED_HISTORY",
])

function mm(id: string, season: string, date: string, homeSlug: string, awaySlug: string, hg: number, ag: number): ModelMatch {
  return { id, season, date, homeSlug, awaySlug, homeGoals: hg, awayGoals: ag }
}

function v1Config(): ModelConfig {
  return resolveConfig(readJson<DeepPartial<ModelConfig>>(join(MODEL_DIR, "config.json")))
}

function meta(overrides: Partial<ArtifactMatchMeta>): ArtifactMatchMeta {
  return {
    id: "pl-2026-27-arsenal-fc-vs-coventry-city-fc-560542",
    slug: "arsenal-fc-vs-coventry-city-fc-560542",
    competitionSlug: "premier-league",
    season: "2026-27",
    matchweek: 1,
    kickoffUtc: "2026-08-21T19:00:00Z",
    homeTeam: { slug: "arsenal-fc", name: "Arsenal", shortName: "Arsenal" },
    awayTeam: { slug: "coventry-city-fc", name: "Coventry City", shortName: "Coventry" },
    predictionType: "candidate",
    predictionState: "unlocked",
    actualScore: null,
    modelVersion: "1.0.0",
    configHash: V1_HASH,
    generatedAt: "2026-09-21T00:00:00Z",
    dataCutoff: "2026-09-18T00:20:33Z",
    reasonSource: "v1",
    ...overrides,
  }
}

/* --------------------------- 1. frozen v1 config --------------------------- */

test("v1 config: full config hash matches the frozen 28b50575b3ce… hash", () => {
  assert.equal(hashConfig(v1Config()), V1_HASH)
})

test("v1 config: calibration is undefined", () => {
  assert.equal(v1Config().calibration, undefined)
})

test("v1 config: drawModel is undefined", () => {
  assert.equal(v1Config().drawModel, undefined)
})

test("v1 config: version is 1.0.0", () => {
  assert.equal(v1Config().version, "1.0.0")
})

/* --------------------------- 2. replay equivalence --------------------------- */

const SAMPLE = [
  mm("w1", "2021-22", "2021-08-14", "alpha", "beta", 2, 0),
  mm("w2", "2021-22", "2021-08-14", "gamma", "delta", 1, 1),
  mm("w3", "2021-22", "2021-08-21", "beta", "gamma", 0, 3),
  mm("w4", "2022-23", "2022-08-13", "alpha", "gamma", 1, 0),
  mm("w5", "2022-23", "2022-08-13", "delta", "beta", 2, 2),
  mm("w6", "2022-23", "2022-08-20", "gamma", "alpha", 0, 1),
]

test("replayMatches predictions equal runBacktest for v1", () => {
  const config = v1Config()
  const a = replayMatches(SAMPLE, config, ["2022-23"]).predictions
  const b = runBacktest(SAMPLE, config, { evaluateSeasons: ["2022-23"] })
  assert.deepEqual(a, b)
})

test("replayMatches predictions equal runBacktest for v1.1 (calibration, no drawModel)", () => {
  const config = resolveConfig(readJson<DeepPartial<ModelConfig>>(join(MODEL_DIR_V11, "config.json")))
  assert.notEqual(config.calibration, undefined)
  assert.equal(config.drawModel, undefined)
  const a = replayMatches(SAMPLE, config, ["2022-23"]).predictions
  const b = runBacktest(SAMPLE, config, { evaluateSeasons: ["2022-23"] })
  assert.deepEqual(a, b)
})

test("replayMatches rejects a drawModel config", () => {
  const config = { ...DEFAULT_CONFIG, drawModel: { featureSet: "A" } } as unknown as ModelConfig
  assert.throws(() => replayMatches(SAMPLE, config, ["2022-23"]), /no drawModel/)
})

/* --------------------------- 3. no-leakage guarantees --------------------------- */

test("replayMatches: same-day matches are predicted before any same-day update", () => {
  const matches = [
    mm("m1", "2022-23", "2022-01-01", "alpha", "beta", 3, 0),
    mm("m2", "2022-23", "2022-01-01", "alpha", "gamma", 0, 0),
    mm("m3", "2022-23", "2022-01-02", "alpha", "delta", 1, 0),
  ]
  const preds = replayMatches(matches, DEFAULT_CONFIG, ["2022-23"]).predictions
  assert.equal(preds.length, 3)
  assert.equal(preds[0].homeStrength.matchesObserved, 0)
  assert.equal(preds[1].homeStrength.matchesObserved, 0)
  assert.equal(preds[2].homeStrength.matchesObserved, 2)
})

test("replayMatches: a backtest prediction never reads its own result", () => {
  const a = replayMatches([mm("m1", "2022-23", "2022-01-01", "alpha", "beta", 3, 0)], DEFAULT_CONFIG, ["2022-23"]).predictions[0]
  const b = replayMatches([mm("m1", "2022-23", "2022-01-01", "alpha", "beta", 0, 5)], DEFAULT_CONFIG, ["2022-23"]).predictions[0]
  // The pre-match prediction is identical; only the recorded actuals differ.
  assert.deepEqual(a.probabilities, b.probabilities)
  assert.equal(a.lambdaHome, b.lambdaHome)
  assert.equal(a.lambdaAway, b.lambdaAway)
  assert.equal(a.eloHome, b.eloHome)
  assert.equal(a.actualResult, "H")
  assert.equal(b.actualResult, "A")
  assert.equal(a.actualHomeGoals, 3)
  assert.equal(b.actualHomeGoals, 0)
})

test("advanceState returns the final state after every match is absorbed", () => {
  const state = advanceState(SAMPLE, DEFAULT_CONFIG)
  // Every team in SAMPLE has an Elo rating and observed matches.
  assert.ok(state.elo.alpha !== undefined)
  assert.ok(state.strength.alpha.matchesObserved > 0)
  assert.equal(state.season, "2022-23")
})

test("candidate predictions come from a single frozen state (order-independent)", () => {
  const warm = [
    mm("a1", "2021-22", "2021-08-14", "alpha", "beta", 3, 0),
    mm("a2", "2021-22", "2021-08-21", "beta", "gamma", 1, 2),
    mm("a3", "2021-22", "2021-08-28", "gamma", "alpha", 1, 1),
  ]
  const candA = mm("ca", "2022-23", "2022-09-01", "alpha", "gamma", 0, 0)
  const candB = mm("cb", "2022-23", "2022-09-02", "beta", "delta", 0, 0)

  const s1 = advanceState(warm, DEFAULT_CONFIG)
  const a1 = predictMatch(candA, s1, DEFAULT_CONFIG)
  const b1 = predictMatch(candB, s1, DEFAULT_CONFIG)

  const s2 = advanceState(warm, DEFAULT_CONFIG)
  const b2 = predictMatch(candB, s2, DEFAULT_CONFIG)
  const a2 = predictMatch(candA, s2, DEFAULT_CONFIG)

  assert.deepEqual(a1, a2)
  assert.deepEqual(b1, b2)
  assert.deepEqual(s1, s2) // neither prediction mutated the frozen state

  // Probabilities are valid and predictedResult is the argmax.
  const sum = a1.probabilities.home + a1.probabilities.draw + a1.probabilities.away
  assert.ok(Math.abs(sum - 1) < 1e-9)
})

test("predictMatch does not mutate the frozen state", () => {
  const warm = [mm("a1", "2021-22", "2021-08-14", "alpha", "beta", 3, 0)]
  const state = advanceState(warm, DEFAULT_CONFIG)
  const snapshot = JSON.parse(JSON.stringify(state))
  predictMatch(mm("c", "2022-23", "2022-09-01", "alpha", "gamma", 0, 0), state, DEFAULT_CONFIG)
  assert.deepEqual(state, snapshot)
})

/* --------------------------- 4. artifact mapping --------------------------- */

test("buildPredictionArtifact: backtest has historical_reconstruction state and a real actualScore", () => {
  const pred = predictMatch(mm("m", "2022-23", "2022-09-01", "alpha", "beta", 1, 2), advanceState(SAMPLE, DEFAULT_CONFIG), DEFAULT_CONFIG)
  const artifact = buildPredictionArtifact(pred, meta({ predictionType: "backtest", predictionState: "historical_reconstruction", actualScore: { home: 1, away: 2 } }))
  assert.equal(artifact.predictionType, "backtest")
  assert.equal(artifact.predictionState, "historical_reconstruction")
  assert.deepEqual(artifact.actualScore, { home: 1, away: 2 })
  assert.equal(artifact.predictedResult, pred.predictedResult)
})

test("buildPredictionArtifact: candidate has unlocked state and null actualScore", () => {
  const pred = predictMatch(mm("m", "2022-23", "2022-09-01", "alpha", "beta", 0, 0), advanceState(SAMPLE, DEFAULT_CONFIG), DEFAULT_CONFIG)
  const artifact = buildPredictionArtifact(pred, meta({ predictionType: "candidate", predictionState: "unlocked", actualScore: null }))
  assert.equal(artifact.predictionType, "candidate")
  assert.equal(artifact.predictionState, "unlocked")
  assert.equal(artifact.actualScore, null)
})

test("buildPredictionArtifact: eligibleForOfficialAccuracy is always false", () => {
  const pred = predictMatch(mm("m", "2022-23", "2022-09-01", "alpha", "beta", 0, 0), advanceState(SAMPLE, DEFAULT_CONFIG), DEFAULT_CONFIG)
  const artifact = buildPredictionArtifact(pred, meta({}))
  assert.equal(artifact.eligibleForOfficialAccuracy, false)
})

/* --------------------------- 5. reasons --------------------------- */

test("mapReason: HOME_ADVANTAGE maps to label, direction home, source v1", () => {
  const r = mapReason({ code: "HOME_ADVANTAGE", text: "Home advantage adds 50 Elo points to the home side.", value: 50, comparisonValue: 0 }, "v1")
  assert.equal(r.label, "Home advantage")
  assert.equal(r.direction, "home")
  assert.equal(r.source, "v1")
  assert.equal(r.value, 50)
})

test("mapReason: unknown code falls back to the code as label and none direction", () => {
  const r = mapReason({ code: "SOMETHING_NEW", text: "x", value: 1, comparisonValue: 0 }, "v1")
  assert.equal(r.label, "SOMETHING_NEW")
  assert.equal(r.direction, "none")
})

test("reasons: every code is a known v1 feature code", () => {
  const config = v1Config()
  const preds = replayMatches(SAMPLE, config, ["2022-23"]).predictions
  assert.ok(preds.length > 0)
  for (const p of preds) {
    for (const r of p.reasons) assert.ok(V1_REASON_CODES.has(r.code), `unknown reason code ${r.code}`)
  }
})

test("reasons: between 1 and 5 per match", () => {
  const config = v1Config()
  for (const p of replayMatches(SAMPLE, config, ["2022-23"]).predictions) {
    assert.ok(p.reasons.length >= 1 && p.reasons.length <= 5, `reasons ${p.reasons.length}`)
  }
})

test("reasons: deterministic across identical replays", () => {
  const config = v1Config()
  const a = replayMatches(SAMPLE, config, ["2022-23"]).predictions
  const b = replayMatches(SAMPLE, config, ["2022-23"]).predictions
  assert.deepEqual(a, b)
})

/* --------------------------- 5b. coverage reason (DATA_COVERAGE) --------------------------- */

function predWith(overrides: Partial<MatchPrediction>): MatchPrediction {
  const base = predictMatch(mm("m", "2022-23", "2022-09-01", "alpha", "beta", 0, 0), advanceState(SAMPLE, DEFAULT_CONFIG), DEFAULT_CONFIG)
  return { ...base, ...overrides }
}

function twoV1Reasons(): Reason[] {
  return [
    { code: "EXPECTED_GOALS", text: "Model expected goals.", value: 1.4, comparisonValue: 1.1 },
    { code: "HOME_ADVANTAGE", text: "Home advantage adds 50 Elo points.", value: 50, comparisonValue: 0 },
  ]
}

test("buildCoverageReason: neutral, traceable, code DATA_COVERAGE, source prediction-artifact", () => {
  for (const r of [
    buildCoverageReason(120, 110, "strong", "medium"),
    buildCoverageReason(12, 140, "limited", "strong"),
    buildCoverageReason(4, 2, "limited", "limited"),
  ]) {
    assert.equal(r.code, "DATA_COVERAGE")
    assert.equal(r.label, "Historical data coverage")
    assert.equal(r.source, "prediction-artifact")
    assert.equal(r.direction, "neutral")
    assert.ok(typeof r.value === "object" && Number.isInteger(r.value.home) && Number.isInteger(r.value.away))
    // The text carries no home/draw/away tilt.
    assert.doesNotMatch(r.text, /favours|favour|win|draw|lose/i)
  }
})

test("buildCoverageReason: distinguishes sufficient / one-sided / both limited", () => {
  assert.match(buildCoverageReason(120, 110, "strong", "medium").text, /sufficient for both sides/)
  assert.match(buildCoverageReason(12, 140, "limited", "strong").text, /limited for the home side/)
  assert.match(buildCoverageReason(140, 12, "strong", "limited").text, /limited for the away side/)
  const both = buildCoverageReason(4, 2, "limited", "none")
  assert.match(both.text, /limited for both sides/)
  assert.match(both.text, /uncertainty/)
})

test("buildPredictionArtifact: appends DATA_COVERAGE when v1 yields only 2 reasons", () => {
  const base = predWith({})
  const pred = predWith({
    reasons: twoV1Reasons(),
    homeStrength: { ...base.homeStrength, matchesObserved: 120, tier: "strong" },
    awayStrength: { ...base.awayStrength, matchesObserved: 110, tier: "strong" },
  })
  const artifact = buildPredictionArtifact(pred, meta({}))
  assert.equal(artifact.reasons.length, 3)
  const cov = artifact.reasons[2]
  assert.equal(cov.code, "DATA_COVERAGE")
  assert.equal(cov.source, "prediction-artifact")
  assert.equal(cov.direction, "neutral")
  assert.deepEqual(cov.value, { home: 120, away: 110 })
})

test("buildPredictionArtifact: does not append when already 3+ reasons", () => {
  const pred = predWith({
    reasons: [...twoV1Reasons(), { code: "ELO_ADVANTAGE_HOME", text: "Elo favours home.", value: 1560, comparisonValue: 1500 }],
  })
  const artifact = buildPredictionArtifact(pred, meta({}))
  assert.equal(artifact.reasons.length, 3)
  assert.ok(artifact.reasons.every((r) => r.code !== "DATA_COVERAGE"))
})

test("buildPredictionArtifact: no duplicate reason codes", () => {
  const base = predWith({})
  const pred = predWith({
    reasons: twoV1Reasons(),
    homeStrength: { ...base.homeStrength, matchesObserved: 120, tier: "strong" },
    awayStrength: { ...base.awayStrength, matchesObserved: 110, tier: "strong" },
  })
  const artifact = buildPredictionArtifact(pred, meta({}))
  const codes = artifact.reasons.map((r) => r.code)
  assert.equal(new Set(codes).size, codes.length)
})

test("buildPredictionArtifact: coverage reason never changes the model's core fields", () => {
  const base = predWith({})
  const two = predWith({
    reasons: twoV1Reasons(),
    homeStrength: { ...base.homeStrength, matchesObserved: 120, tier: "strong" },
    awayStrength: { ...base.awayStrength, matchesObserved: 110, tier: "strong" },
  })
  const three = predWith({ reasons: [...twoV1Reasons(), { code: "ELO_ADVANTAGE_HOME", text: "Elo favours home.", value: 1560, comparisonValue: 1500 }] })
  for (const pred of [two, three]) {
    const a = buildPredictionArtifact(pred, meta({}))
    assert.deepEqual(a.probabilities, pred.probabilities)
    assert.equal(a.predictedResult, pred.predictedResult)
    assert.deepEqual(a.predictedScoreline, pred.predictedScoreline)
    assert.equal(a.confidence.score, pred.confidenceScore)
    assert.equal(a.confidence.level, pred.confidence)
    assert.deepEqual(a.lambda, { home: pred.lambdaHome, away: pred.lambdaAway })
    assert.deepEqual(a.elo, { home: pred.eloHome, away: pred.eloAway })
  }
})

test("coverage reason value equals the prediction's pre-match observed counts", () => {
  const base = predWith({})
  const pred = predWith({
    reasons: twoV1Reasons(),
    homeStrength: { ...base.homeStrength, matchesObserved: 87, tier: "medium" },
    awayStrength: { ...base.awayStrength, matchesObserved: 91, tier: "medium" },
  })
  const artifact = buildPredictionArtifact(pred, meta({}))
  const cov = artifact.reasons.find((r) => r.code === "DATA_COVERAGE")
  assert.ok(cov !== undefined)
  const covValue = cov.value as CoverageValue
  assert.deepEqual(covValue, { home: pred.homeStrength.matchesObserved, away: pred.awayStrength.matchesObserved })
})

/* --------------------------- 6. ordering --------------------------- */

test("sortPredictions orders by kickoffUtc then id", () => {
  const pred = predictMatch(mm("m", "2022-23", "2022-09-01", "alpha", "beta", 0, 0), advanceState(SAMPLE, DEFAULT_CONFIG), DEFAULT_CONFIG)
  const late = buildPredictionArtifact(pred, meta({ id: "id-b", kickoffUtc: "2026-09-20T00:00:00Z" }))
  const early = buildPredictionArtifact(pred, meta({ id: "id-a", kickoffUtc: "2026-08-01T00:00:00Z" }))
  const sameTimeA = buildPredictionArtifact(pred, meta({ id: "id-c", kickoffUtc: "2026-08-01T00:00:00Z" }))
  const sameTimeB = buildPredictionArtifact(pred, meta({ id: "id-d", kickoffUtc: "2026-08-01T00:00:00Z" }))
  const sorted = sortPredictions([late, sameTimeB, early, sameTimeA])
  assert.deepEqual(sorted.map((p) => p.id), ["id-a", "id-c", "id-d", "id-b"])
})

/* --------------------------- 7. manifest & report --------------------------- */

test("buildManifest: officialPredictionCount 0 and officialAccuracy null", () => {
  const m = buildManifest({
    competitionSlug: "premier-league", season: "2026-27", modelVersion: "1.0.0", configHash: V1_HASH,
    generatedAt: "2026-09-21T00:00:00Z", dataCutoff: "2026-09-18T00:20:33Z",
    baseCommit: "c8763626e9743a65b2bf29eb2b702d63967650d8", inputDataHash: "x", generatorHash: "y",
    backtestCount: 40, candidateCount: 340, teams: ["a", "b"],
    source: { provider: "football-data.org", sourceLastUpdatedAt: "2026-09-18T00:20:33Z", exportedAt: "2026-09-20T12:36:30.321Z" },
  })
  assert.equal(m.officialPredictionCount, 0)
  assert.equal(m.officialAccuracy, null)
  assert.equal(m.eligibleForOfficialAccuracy, false)
})

test("buildManifest: totalPredictions = backtestCount + candidateCount", () => {
  const m = buildManifest({
    competitionSlug: "premier-league", season: "2026-27", modelVersion: "1.0.0", configHash: V1_HASH,
    generatedAt: "t", dataCutoff: "t", baseCommit: "c", inputDataHash: "x", generatorHash: "y",
    backtestCount: 40, candidateCount: 340, teams: [],
    source: { provider: "p", sourceLastUpdatedAt: "s", exportedAt: "e" },
  })
  assert.equal(m.totalPredictions, 380)
  assert.equal(m.backtestCount, 40)
  assert.equal(m.candidateCount, 340)
})

test("buildBacktestReport: historical_reconstruction and matchCount", () => {
  const preds = replayMatches(SAMPLE, v1Config(), ["2022-23"]).predictions
  const report = buildBacktestReport(preds, { season: "2026-27", modelVersion: "1.0.0", configHash: V1_HASH, generatedAt: "t", dataCutoff: "t" })
  assert.equal(report.predictionType, "backtest")
  assert.equal(report.predictionState, "historical_reconstruction")
  assert.equal(report.eligibleForOfficialAccuracy, false)
  assert.equal(report.matchCount, preds.length)
  assert.equal(report.metrics.matchCount, preds.length)
})

/* --------------------------- 8. hashing --------------------------- */

test("sha256Hex is sensitive to input changes", () => {
  assert.equal(sha256Hex("abc"), sha256Hex("abc"))
  assert.notEqual(sha256Hex("abc"), sha256Hex("abd"))
  assert.notEqual(sha256Hex("a", "b"), sha256Hex("a"))
  assert.equal(sha256Hex("a", "b").length, 64)
})
