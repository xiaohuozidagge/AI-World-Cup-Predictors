/**
 * Manual adjustment for the 2026/27 Premier League predictions (Phase VIII).
 *
 * Adjustments are ONLY allowed before the season seal. This command appends one
 * audit event to `adjustments.json` (never modifies `predictions.json` or the
 * sealed snapshot). After the seal exists it refuses with a hard error.
 *
 * NOTE: this command must NOT be run against the real 340-match dataset in this
 * phase; it exists so the mechanism is complete and testable.
 */

import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { PredictionArtifact } from "../lib/model/prediction-artifact"
import {
  applyAdjustment,
  assertAdjustableTarget,
  emptyAdjustmentLedger,
  guardAgainstPostSealAdjustment,
  type AdjustmentLedger,
  type AdjustmentProposal,
} from "../lib/predictions/prediction-adjustment"
import type { EligibilityOverridesFile } from "../lib/predictions/prediction-classification"
import { systemClock } from "../lib/predictions/prediction-lock"
import { COMPETITION_SLUG, fail, OUTPUT_DIR, readJson, SEASON } from "./prediction-inputs"
import type { ConfidenceLevel } from "../lib/model/types"

const ADJUSTMENTS_PATH = join(OUTPUT_DIR, "adjustments.json")
const OVERRIDES_PATH = join(OUTPUT_DIR, "eligibility-overrides.json")
const SEAL_MANIFEST_PATH = join(OUTPUT_DIR, "seal-manifest.json")

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function parseNumbers(value: string): number[] {
  return value.split(",").map((n) => Number(n.trim()))
}

function main(): void {
  // Adjustments are forbidden once the season is sealed.
  guardAgainstPostSealAdjustment(existsSync(SEAL_MANIFEST_PATH))

  const matchId = arg("--match-id")
  const editorId = arg("--editor-id")
  const reason = arg("--reason")
  const probabilitiesArg = arg("--probabilities")
  const scorelineArg = arg("--scoreline")
  const confidenceArg = arg("--confidence")

  if (!matchId || !editorId || !reason) {
    fail("usage: predictions:pl:adjust --match-id <id> --editor-id <id> --reason <text> [--probabilities h,d,a] [--scoreline h,a] [--confidence score,level]")
  }

  const predictions = readJson<PredictionArtifact[]>(join(OUTPUT_DIR, "predictions.json"))
  const current = predictions.find((p) => p.id === matchId)
  if (!current) fail(`no prediction found for matchId ${matchId}`)

  // Late backtests are permanently ineligible and therefore never adjustable.
  const permanentlyIneligible = existsSync(OVERRIDES_PATH)
    ? readJson<EligibilityOverridesFile>(OVERRIDES_PATH).overrides.some((o) => o.matchId === matchId)
    : false
  try {
    assertAdjustableTarget(current, permanentlyIneligible)
  } catch (err) {
    fail((err as Error).message)
  }

  const proposal: AdjustmentProposal = { editorId, reason }
  if (probabilitiesArg) {
    const [home, draw, away] = parseNumbers(probabilitiesArg)
    proposal.probabilities = { home, draw, away }
  }
  if (scorelineArg) {
    const [home, away] = parseNumbers(scorelineArg)
    proposal.predictedScoreline = { home, away }
  }
  if (confidenceArg) {
    const [score, level] = confidenceArg.split(",").map((s) => s.trim())
    proposal.confidence = { score: Number(score), level: level as ConfidenceLevel }
  }
  if (!proposal.probabilities && !proposal.predictedScoreline && !proposal.confidence) {
    fail("no adjustable field provided (probabilities / scoreline / confidence)")
  }

  const ledger: AdjustmentLedger = existsSync(ADJUSTMENTS_PATH)
    ? readJson<AdjustmentLedger>(ADJUSTMENTS_PATH)
    : emptyAdjustmentLedger(COMPETITION_SLUG, SEASON)

  const updated = applyAdjustment(ledger, current, proposal, systemClock.now().toISOString())
  writeFileSync(ADJUSTMENTS_PATH, JSON.stringify(updated, null, 2) + "\n", "utf-8")

  const ev = updated.events[updated.events.length - 1]
  console.log(`predictions:pl:adjust — revision ${ev.revision} for ${ev.matchId} by ${ev.editorId}`)
  console.log(`  changedFields: ${ev.changedFields.join(", ")}`)
  console.log(`  adjustmentHash: ${ev.adjustmentHash}`)
  console.log(`  manualAdjustmentCount: ${updated.manualAdjustmentCount}`)
}

main()
