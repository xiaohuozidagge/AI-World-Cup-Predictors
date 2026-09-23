/**
 * Season-wide sealing for the 2026/27 Premier League predictions (Phase VIII, revised).
 *
 * The 10 Phase VII candidates whose kickoffs have already passed at the real
 * seal time are frozen as permanently-ineligible "late backtests" (via
 * eligibility-overrides.json) — never deleted, never back-dated, never counted
 * toward official accuracy. The remaining 330 still-future candidates are sealed
 * in one "remaining_future_season_publication" batch with a single real UTC
 * `sealedAt`. The Phase VII originals are never modified. `--dry-run` prints the
 * full report without writing; re-running after a successful seal fails with
 * `SEASON_ALREADY_SEALED` (no silent overwrite).
 */

import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { PredictionArtifact, PredictionManifest } from "../lib/model/prediction-artifact"
import {
  buildEffectiveCatalog,
  buildEligibilityOverridesFile,
} from "../lib/predictions/prediction-classification"
import { emptyAdjustmentLedger, type AdjustmentLedger } from "../lib/predictions/prediction-adjustment"
import {
  buildLockPolicy,
  buildRemainingFutureSealedPredictions,
  buildSealManifest,
  classifyCandidates,
  findBlockedMatches,
  hashObject,
  systemClock,
} from "../lib/predictions/prediction-lock"
import {
  assert,
  computeGeneratorHash,
  computeInputDataHash,
  COMPETITION_SLUG,
  currentCommit,
  fail,
  loadV1Config,
  MODEL_VERSION,
  OUTPUT_DIR,
  readJson,
  SEASON,
  V1_CONFIG_HASH,
} from "./prediction-inputs"

const LOCK_POLICY_PATH = join(OUTPUT_DIR, "lock-policy.json")
const ADJUSTMENTS_PATH = join(OUTPUT_DIR, "adjustments.json")
const OVERRIDES_PATH = join(OUTPUT_DIR, "eligibility-overrides.json")
const CATALOG_PATH = join(OUTPUT_DIR, "effective-prediction-catalog.json")
const SEALED_PATH = join(OUTPUT_DIR, "sealed-predictions.json")
const SEAL_MANIFEST_PATH = join(OUTPUT_DIR, "seal-manifest.json")

/**
 * The exact 10 candidates that had already kicked off at the first Phase VIII
 * dry-run (2026-09-18..20). The revised seal refuses to proceed unless the
 * classified late-backtest set still matches this list exactly.
 */
const EXPECTED_LATE_BACKTEST_IDS = [
  "pl-2026-27-brentford-fc-vs-chelsea-fc-560591",
  "pl-2026-27-tottenham-hotspur-fc-vs-aston-villa-fc-560587",
  "pl-2026-27-brighton-hove-albion-fc-vs-arsenal-fc-560586",
  "pl-2026-27-everton-fc-vs-ipswich-town-fc-560584",
  "pl-2026-27-newcastle-united-fc-vs-hull-city-afc-560588",
  "pl-2026-27-nottingham-forest-fc-vs-coventry-city-fc-560589",
  "pl-2026-27-afc-bournemouth-vs-liverpool-fc-560582",
  "pl-2026-27-leeds-united-fc-vs-crystal-palace-fc-560585",
  "pl-2026-27-manchester-city-fc-vs-sunderland-afc-560590",
  "pl-2026-27-fulham-fc-vs-manchester-united-fc-560583",
]

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8")
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run")

  // Re-running after a successful seal must never silently overwrite.
  if (existsSync(SEAL_MANIFEST_PATH)) {
    fail("SEASON_ALREADY_SEALED — seal-manifest.json already exists; refusing to overwrite the sealed snapshot")
  }

  const manifest = readJson<PredictionManifest>(join(OUTPUT_DIR, "manifest.json"))
  const predictions = readJson<PredictionArtifact[]>(join(OUTPUT_DIR, "predictions.json"))

  // Validate the frozen v1 model and the committed input/generator state.
  assert(manifest.configHash === V1_CONFIG_HASH, "manifest.configHash is not the frozen v1 hash")
  loadV1Config() // asserts version 1.0.0 + frozen v1 config hash
  assert(manifest.modelVersion === MODEL_VERSION, "manifest.modelVersion is not 1.0.0")
  assert(manifest.inputDataHash === computeInputDataHash(), "inputDataHash mismatch — data changed since Phase VII")
  assert(manifest.generatorHash === computeGeneratorHash(), "generatorHash mismatch — generator changed since Phase VII")
  assert(manifest.totalPredictions === 380 && manifest.backtestCount === 40 && manifest.candidateCount === 340, "manifest counts must be 380/40/340")

  const backtests = predictions.filter((p) => p.predictionType === "backtest")
  const candidates = predictions.filter((p) => p.predictionType === "candidate")
  assert(backtests.length === 40, `expected 40 backtests, got ${backtests.length}`)
  assert(candidates.length === 340, `expected 340 candidates, got ${candidates.length}`)

  // Adjustments may only exist before sealing; this phase seals with zero.
  const ledger: AdjustmentLedger = existsSync(ADJUSTMENTS_PATH)
    ? readJson<AdjustmentLedger>(ADJUSTMENTS_PATH)
    : emptyAdjustmentLedger(COMPETITION_SLUG, SEASON)
  assert(ledger.manualAdjustmentCount === 0, "this phase must seal with zero manual adjustments")

  const sealedAt = systemClock.now().toISOString()
  const sourceCommit = currentCommit()
  const sourcePredictionsHash = hashObject(predictions)
  const adjustmentLedgerHash = hashObject(ledger)

  const { lateBacktests, futureCandidates } = classifyCandidates(candidates, sealedAt)
  const lateIds = lateBacktests.map((c) => c.id)
  const futureBlocked = findBlockedMatches(futureCandidates, sealedAt)

  // §五: if the started-candidate set is no longer exactly these 10, stop now.
  if (lateBacktests.length !== 10) {
    console.error(`predictions:pl:seal — late-backtest count is no longer 10 (now ${lateBacktests.length}); stopping per §五`)
    console.error("  late backtests now:")
    for (const c of lateBacktests) console.error(`  - ${c.id} @ ${c.kickoffUtc}`)
    fail(`started candidates are no longer exactly 10 — no real seal`)
  }
  assert(sameIds(lateIds, EXPECTED_LATE_BACKTEST_IDS), "the 10 late-backtest ids do not match the prior dry-run list")
  assert(futureCandidates.length === 330, `expected exactly 330 remaining future candidates, got ${futureCandidates.length}`)

  const allSealable = futureBlocked.length === 0

  if (dryRun) {
    console.log("predictions:pl:seal --dry-run")
    console.log(`  current UTC (sealedAt): ${sealedAt}`)
    console.log(`  original backtests: ${backtests.length}`)
    console.log(`  late backtests: ${lateBacktests.length}`)
    console.log(`  remaining future candidates: ${futureCandidates.length}`)
    console.log(`  all 330 sealable: ${allSealable ? "yes" : `no (${futureBlocked.length} blocked)`}`)
    console.log(`  input hash (predictions.json): ${sourcePredictionsHash}`)
    console.log("  late backtests:")
    for (const c of lateBacktests) console.log(`    - ${c.id} @ ${c.kickoffUtc}`)
    if (!allSealable) {
      for (const b of futureBlocked) console.error(`  BLOCKED: ${b.id} @ ${b.kickoffUtc}`)
      console.log("  (no files written)")
      fail(`dry-run blocked: ${futureBlocked.length} remaining candidate(s) already started — no real seal, no backfill`)
    }
    console.log("  (no files written)")
    return
  }

  if (!allSealable) {
    for (const b of futureBlocked) console.error(`BLOCKED candidate: ${b.id} @ ${b.kickoffUtc}`)
    fail(`seal blocked: ${futureBlocked.length} remaining candidate(s) already started — no partial seal, no auto-shrink`)
  }

  const sealedFile = buildRemainingFutureSealedPredictions({
    predictions,
    sealedAt,
    competitionSlug: COMPETITION_SLUG,
    season: SEASON,
  })

  const overridesFile = buildEligibilityOverridesFile({
    competitionSlug: COMPETITION_SLUG,
    season: SEASON,
    detectedAt: sealedAt,
    lateBacktests,
  })

  const catalogFile = buildEffectiveCatalog({
    competitionSlug: COMPETITION_SLUG,
    season: SEASON,
    originalBacktests: backtests,
    overrides: overridesFile.overrides,
    sealedCandidates: sealedFile.candidates,
  })

  const sealedPredictionsHash = hashObject(sealedFile)
  const eligibilityOverridesHash = hashObject(overridesFile)
  const effectiveCatalogHash = hashObject(catalogFile)

  const sealManifest = buildSealManifest({
    competitionSlug: COMPETITION_SLUG,
    season: SEASON,
    sealMode: "remaining_future_season_publication",
    sealedAt,
    sourceCommit,
    sourcePredictionsHash,
    eligibilityOverridesHash,
    adjustmentLedgerHash,
    sealedPredictionsHash,
    effectiveCatalogHash,
    totalPredictions: 380,
    originalBacktestCount: backtests.length,
    lateBacktestCount: lateBacktests.length,
    sealedCandidateCount: sealedFile.counts.sealedCandidateCount,
    manualAdjustmentCount: 0,
  })

  writeJson(LOCK_POLICY_PATH, buildLockPolicy(COMPETITION_SLUG, SEASON, "remaining_future_season_publication"))
  writeJson(ADJUSTMENTS_PATH, ledger)
  writeJson(OVERRIDES_PATH, overridesFile)
  writeJson(CATALOG_PATH, catalogFile)
  writeJson(SEALED_PATH, sealedFile)
  writeJson(SEAL_MANIFEST_PATH, sealManifest)

  console.log(`predictions:pl:seal — sealed ${sealedFile.counts.sealedCandidateCount} future candidates at ${sealedAt}`)
  console.log(`  original backtests: ${sealedFile.counts.originalBacktestCount}, late backtests: ${sealedFile.counts.lateBacktestCount}, total backtests: ${sealedFile.counts.totalBacktestCount}`)
  console.log(`  sourceCommit: ${sourceCommit}`)
  console.log(`  sourcePredictionsHash: ${sourcePredictionsHash}`)
  console.log(`  sealedPredictionsHash: ${sealedPredictionsHash}`)
  console.log(`  batchHash: ${sealedFile.batchHash}`)
  console.log(`  officialPredictionCount: 0, officialAccuracy: null, publishedPredictionCount: 0`)
}

main()
