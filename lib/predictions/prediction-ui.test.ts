import { test } from "node:test"
import assert from "node:assert/strict"

import { confidenceBadgeVariant, CONFIDENCE_BADGE_VARIANTS } from "./prediction-ui"
import {
  confidenceLabel,
  largestRemainderPercentages,
  predictionStatusMeta,
  type PublicPredictionStatus,
} from "./public-prediction"

test("confidence badge variants: low neutral, medium emphasis, high strong", () => {
  assert.equal(confidenceBadgeVariant("low"), "secondary")
  assert.equal(confidenceBadgeVariant("medium"), "info")
  assert.equal(confidenceBadgeVariant("high"), "success")
  assert.equal(CONFIDENCE_BADGE_VARIANTS.low, "secondary")
  assert.equal(CONFIDENCE_BADGE_VARIANTS.medium, "info")
  assert.equal(CONFIDENCE_BADGE_VARIANTS.high, "success")
})

test("every confidence level carries an explicit text label (colour is never the only signal)", () => {
  for (const level of ["low", "medium", "high"] as const) {
    const label = confidenceLabel(level)
    assert.match(label, /Confidence/, `${level} label must name the confidence level`)
    assert.ok(confidenceBadgeVariant(level), `${level} must have a badge variant`)
  }
})

test("status badge text and variant are consistent and never colour-only", () => {
  const expected: Record<PublicPredictionStatus, { label: string; variant: string }> = {
    backtest: { label: "Backtest", variant: "secondary" },
    historical_reconstruction: { label: "Historical Reconstruction", variant: "warning" },
    sealed: { label: "Sealed AI Prediction", variant: "info" },
  }
  for (const status of Object.keys(expected) as PublicPredictionStatus[]) {
    const meta = predictionStatusMeta(status)
    assert.equal(meta.label, expected[status].label)
    assert.equal(meta.badgeVariant, expected[status].variant)
    assert.ok(meta.description.length > 0, `${status} must carry a text description`)
  }
})

test("1X2 percentages are integers that always sum to exactly 100", () => {
  const cases: Array<[number, number, number]> = [
    [0.52, 0.25, 0.23],
    [0.4, 0.3, 0.3],
    [0.18, 0.22, 0.6],
    [0.3333, 0.3333, 0.3334],
  ]
  for (const [h, d, a] of cases) {
    const [H, D, A] = largestRemainderPercentages(h, d, a)
    assert.ok(Number.isInteger(H) && Number.isInteger(D) && Number.isInteger(A))
    assert.equal(H + D + A, 100, `percentages must sum to 100 for [${h}, ${d}, ${a}]`)
  }
})
