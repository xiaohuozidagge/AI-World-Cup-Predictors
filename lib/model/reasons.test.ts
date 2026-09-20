import { test } from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_CONFIG } from "./config"
import { generateReasons, type ReasonContext } from "./reasons"

const STRONG = { homeAttack: 1.2, awayAttack: 1.1, homeDefense: 0.9, awayDefense: 0.8, matchesObserved: 60, tier: "strong" as const }
const NONE = { homeAttack: 1, awayAttack: 1, homeDefense: 1, awayDefense: 1, matchesObserved: 0, tier: "none" as const }

function ctx(overrides: Partial<ReasonContext>): ReasonContext {
  return {
    homeSlug: "manchester-city-fc",
    awaySlug: "luton-town-fc",
    eloHome: 1620,
    eloAway: 1480,
    rawEloDiff: 140,
    eloDiff: 205,
    homeAdvantage: 65,
    homeStrength: STRONG,
    awayStrength: STRONG,
    leagueHomeAvg: 1.5,
    leagueAwayAvg: 1.2,
    lambdaHome: 1.9,
    lambdaAway: 1.0,
    probabilities: { home: 0.55, draw: 0.25, away: 0.2 },
    predictedResult: "H",
    ...overrides,
  }
}

test("generateReasons: Elo advantage is reported for the stronger side", () => {
  const reasons = generateReasons(ctx({}), DEFAULT_CONFIG)
  assert.ok(reasons.some((r) => r.code === "ELO_ADVANTAGE_HOME"))
  assert.ok(reasons.some((r) => r.value === 1620 && r.comparisonValue === 1480))
})

test("generateReasons: limited history always emits the mandated reason", () => {
  const reasons = generateReasons(ctx({ homeStrength: NONE, awayStrength: NONE, rawEloDiff: 0 }), DEFAULT_CONFIG)
  assert.ok(reasons.some((r) => r.code === "LIMITED_HISTORY"))
  assert.ok(reasons.some((r) => r.text === "Limited Premier League history reduces model confidence."))
})

test("generateReasons: never exceeds the configured maximum", () => {
  const reasons = generateReasons(ctx({}), DEFAULT_CONFIG)
  assert.ok(reasons.length <= DEFAULT_CONFIG.reasons.maxReasons)
  for (const r of reasons) {
    assert.ok(Number.isFinite(r.value))
    assert.ok(Number.isFinite(r.comparisonValue))
    assert.ok(r.code.length > 0)
    assert.ok(r.text.length > 0)
  }
})
