/**
 * Read-only verification of the revised Phase VIII seal artifacts. Re-reads the
 * sealed snapshot, the eligibility overrides, the effective catalog, the
 * adjustment ledger, and the Phase VII predictions, then asserts the manifest
 * hashes, the 40/10/330 split, the unified sealedAt, the per-match original/final/
 * batch hashes, and that nothing is published or officially eligible. Exits
 * non-zero on any failure. No writes.
 */

import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { sha256Hex, type PredictionArtifact } from "../lib/model/prediction-artifact"
import type { AdjustmentLedger } from "../lib/predictions/prediction-adjustment"
import type { EffectiveCatalogFile, EligibilityOverridesFile } from "../lib/predictions/prediction-classification"
import { hashObject, type RemainingFutureSealedFile, type SealManifest } from "../lib/predictions/prediction-lock"
import { assert, currentCommit, OUTPUT_DIR, readJson } from "./prediction-inputs"

const SEAL_MANIFEST_PATH = join(OUTPUT_DIR, "seal-manifest.json")

function isAncestorOrSelf(ancestor: string, head: string): boolean {
  if (ancestor === head) return true
  try {
    execSync(`git merge-base --is-ancestor ${ancestor} ${head}`, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function main(): void {
  assert(existsSync(SEAL_MANIFEST_PATH), "seal-manifest.json missing — run predictions:pl:seal first")

  const manifest = readJson<SealManifest>(SEAL_MANIFEST_PATH)
  const predictions = readJson<PredictionArtifact[]>(join(OUTPUT_DIR, "predictions.json"))
  const adjustments = readJson<AdjustmentLedger>(join(OUTPUT_DIR, "adjustments.json"))
  const overrides = readJson<EligibilityOverridesFile>(join(OUTPUT_DIR, "eligibility-overrides.json"))
  const catalog = readJson<EffectiveCatalogFile>(join(OUTPUT_DIR, "effective-prediction-catalog.json"))
  const sealed = readJson<RemainingFutureSealedFile>(join(OUTPUT_DIR, "sealed-predictions.json"))

  /* ---- seal manifest ---- */
  assert(manifest.season === "2026-27", "wrong season")
  assert(manifest.sealMode === "remaining_future_season_publication", "sealMode must be remaining_future_season_publication")
  assert(isAncestorOrSelf(manifest.sourceCommit, currentCommit()), `sourceCommit ${manifest.sourceCommit} not an ancestor of HEAD ${currentCommit()}`)
  assert(manifest.totalPredictions === 380, "totalPredictions must be 380")
  assert(manifest.originalBacktestCount === 40, "originalBacktestCount must be 40")
  assert(manifest.lateBacktestCount === 10, "lateBacktestCount must be 10")
  assert(manifest.totalBacktestCount === 50, "totalBacktestCount must be 50")
  assert(manifest.sealedCandidateCount === 330, "sealedCandidateCount must be 330")
  assert(manifest.manualAdjustmentCount === 0, "manualAdjustmentCount must be 0")
  assert(manifest.publishedPredictionCount === 0, "publishedPredictionCount must be 0")
  assert(manifest.officialPredictionCount === 0, "officialPredictionCount must be 0")
  assert(manifest.officialAccuracy === null, "officialAccuracy must be null")

  /* ---- cross-file hashes ---- */
  assert(manifest.sourcePredictionsHash === hashObject(predictions), "sourcePredictionsHash mismatch — Phase VII predictions.json changed")
  assert(manifest.eligibilityOverridesHash === hashObject(overrides), "eligibilityOverridesHash mismatch")
  assert(manifest.adjustmentLedgerHash === hashObject(adjustments), "adjustmentLedgerHash mismatch")
  assert(manifest.sealedPredictionsHash === hashObject(sealed), "sealedPredictionsHash mismatch")
  assert(manifest.effectiveCatalogHash === hashObject(catalog), "effectiveCatalogHash mismatch")

  /* ---- Phase VII source still intact ---- */
  const backtests = predictions.filter((p) => p.predictionType === "backtest")
  const candidates = predictions.filter((p) => p.predictionType === "candidate")
  assert(backtests.length === 40, "Phase VII predictions.json no longer has 40 backtests")
  assert(candidates.length === 340, "Phase VII predictions.json no longer has 340 candidates")
  const candidatesById = new Map(candidates.map((c) => [c.id, c]))

  /* ---- eligibility overrides: exactly 10 permanently-ineligible late backtests ---- */
  assert(overrides.lateBacktestCount === 10, "overrides must hold exactly 10 late backtests")
  assert(overrides.overrides.length === 10, "overrides.length must be 10")
  const overrideIds = new Set<string>()
  for (const o of overrides.overrides) {
    assert(o.originalPredictionType === "candidate", `${o.matchId} override must record original candidate type`)
    assert(o.effectivePredictionType === "backtest", `${o.matchId} override must be an effective backtest`)
    assert(o.effectivePredictionState === "post_event_reconstruction", `${o.matchId} override state mismatch`)
    assert(o.permanentlyIneligible === true, `${o.matchId} override must be permanently ineligible`)
    assert(o.eligibleForOfficialAccuracy === false, `${o.matchId} override must not be officially eligible`)
    assert(o.reason === "generated_or_sealed_after_kickoff", `${o.matchId} override reason mismatch`)
    const original = candidatesById.get(o.matchId)
    assert(original, `override id ${o.matchId} not found in Phase VII candidates`)
    assert(o.originalPredictionHash === hashObject(original), `${o.matchId} override originalPredictionHash mismatch`)
    assert(!overrideIds.has(o.matchId), `duplicate override id ${o.matchId}`)
    overrideIds.add(o.matchId)
  }

  /* ---- sealed file ---- */
  assert(sealed.sealMode === "remaining_future_season_publication", "sealed file sealMode mismatch")
  assert(sealed.sealedAt === manifest.sealedAt, "sealed file sealedAt drift from manifest")
  assert(sealed.backtests.excluded === true, "backtests must be explicitly excluded")
  assert(sealed.backtests.originalCount === 40, "sealed backtests.originalCount must be 40")
  assert(sealed.backtests.lateCount === 10, "sealed backtests.lateCount must be 10")
  assert(sealed.backtests.totalCount === 50, "sealed backtests.totalCount must be 50")
  assert(sealed.counts.totalPredictions === 380, "sealed counts totalPredictions must be 380")
  assert(sealed.counts.originalBacktestCount === 40, "sealed counts originalBacktestCount must be 40")
  assert(sealed.counts.lateBacktestCount === 10, "sealed counts lateBacktestCount must be 10")
  assert(sealed.counts.totalBacktestCount === 50, "sealed counts totalBacktestCount must be 50")
  assert(sealed.counts.sealedCandidateCount === 330, "sealed counts sealedCandidateCount must be 330")
  assert(sealed.counts.publishedPredictionCount === 0, "sealed counts publishedPredictionCount must be 0")
  assert(sealed.candidates.length === 330, "sealed file must hold 330 candidates")

  const seenIds = new Set<string>()
  for (const s of sealed.candidates) {
    assert(s.predictionType === "candidate", `${s.id} is not a candidate`)
    assert(s.predictionState === "sealed", `${s.id} is not sealed`)
    assert(s.sealedAt === manifest.sealedAt, `${s.id} does not share the unified sealedAt`)
    assert(s.publishedAt === null, `${s.id} must not be published`)
    assert(s.eligibleForOfficialAccuracy === false, `${s.id} must not be officially eligible`)
    assert(s.adjusted === false, `${s.id} must not be adjusted`)
    assert(s.revision === 1, `${s.id} must be revision 1`)
    assert(Date.parse(s.sealedAt) < Date.parse(s.kickoffUtc), `${s.id} was sealed after its kickoff`)
    assert(!seenIds.has(s.id), `duplicate sealed id ${s.id}`)
    seenIds.add(s.id)

    const original = candidatesById.get(s.id)
    assert(original, `sealed id ${s.id} not found in Phase VII candidates`)
    assert(s.originalPredictionHash === hashObject(original), `${s.id} originalPredictionHash mismatch`)
    assert(s.finalPredictionHash === hashObject({ ...original, predictionState: "sealed" }), `${s.id} finalPredictionHash mismatch`)
    assert(s.originalPredictedResult === original.predictedResult, `${s.id} originalPredictedResult drift`)
  }
  assert(seenIds.size === 330, "sealed ids do not cover all 330 future candidates")

  const expectedBatch = sha256Hex(...sealed.candidates.map((s) => s.finalPredictionHash))
  assert(sealed.batchHash === expectedBatch, "batchHash mismatch")

  /* ---- effective catalog: exactly 380 = 40 + 10 + 330 ---- */
  assert(catalog.totalPredictions === 380, "catalog totalPredictions must be 380")
  assert(catalog.originalBacktestCount === 40, "catalog originalBacktestCount must be 40")
  assert(catalog.lateBacktestCount === 10, "catalog lateBacktestCount must be 10")
  assert(catalog.totalBacktestCount === 50, "catalog totalBacktestCount must be 50")
  assert(catalog.sealedCandidateCount === 330, "catalog sealedCandidateCount must be 330")
  assert(catalog.publishedPredictionCount === 0, "catalog publishedPredictionCount must be 0")
  assert(catalog.entries.length === 380, "catalog entries must be 380")
  const catalogBacktest = catalog.entries.filter((e) => e.effectivePredictionType === "backtest")
  const catalogSealed = catalog.entries.filter((e) => e.effectivePredictionType === "candidate")
  assert(catalogBacktest.length === 50, "catalog must classify 50 entries as backtest")
  assert(catalogSealed.length === 330, "catalog must classify 330 entries as candidate")
  const catalogLate = catalogBacktest.filter((e) => e.effectivePredictionState === "post_event_reconstruction")
  assert(catalogLate.length === 10, "catalog must classify exactly 10 late backtests")
  for (const e of catalogBacktest) assert(e.permanentlyIneligible === true, `${e.matchId} backtest entry must be permanently ineligible`)
  for (const e of catalogSealed) assert(e.permanentlyIneligible === false, `${e.matchId} sealed entry must not be permanently ineligible`)

  console.log("predictions:pl:verify-seal — all checks passed")
  console.log(`  40 original backtests + 10 late backtests excluded, 330 future candidates sealed at ${manifest.sealedAt} (unified)`)
  console.log(`  0 published, 0 official, officialAccuracy null, manualAdjustmentCount 0`)
  console.log(`  sourceCommit: ${manifest.sourceCommit}`)
  console.log(`  sourcePredictionsHash: ${manifest.sourcePredictionsHash}`)
  console.log(`  sealedPredictionsHash: ${manifest.sealedPredictionsHash}`)
  console.log(`  batchHash: ${sealed.batchHash}`)
}

main()
