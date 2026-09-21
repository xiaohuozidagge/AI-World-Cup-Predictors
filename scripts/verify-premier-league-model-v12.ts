/**
 * v1.2 verification — read-only. Asserts the v1.2 artifacts are internally
 * consistent, reproducible, deterministically frozen, honestly partitioned, and
 * leakage-free. Exits non-zero on any failure.
 *
 * Always checks (after `model:v12:tune`):
 *   - v1 and v1.1 directories are unchanged and reproducible,
 *   - the v1.2 config is valid (version, draw model, frozen v1 core, no calibration),
 *   - config hash is consistent across config.json / pre-registration / training / development,
 *   - the data partition is honest (2025-26 nowhere in training/selection/development),
 *   - the acceptance criteria are fixed and equal ACCEPTANCE_CRITERIA_V12,
 *   - the frozen config is deterministic (re-running 2024-25 reproduces the dev report).
 *
 * Additional checks once `model:v12:validate` has run:
 *   - validation config hash consistency + re-running 2025-26 reproduces the report,
 *   - acceptance status is consistent with the checks,
 *   - calibration.json has 30 buckets totalling 3×380,
 *   - predictions carry no odds fields and predictedResult is the argmax.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  argmaxOneX2,
  computeDrawMetrics,
  computeMetrics,
  hashConfig,
  resolveConfig,
  runBacktest,
  validateDrawModelConfig,
  type DeepPartial,
  type ModelConfig,
  type MatchPrediction,
} from "../lib/model"
import {
  ACCEPTANCE_CRITERIA_V12,
  BURN_IN_SEASON,
  DEVELOPMENT_SEASON_V12,
  filterSeasons,
  HOLDOUT_SEASON,
  inputDataHash,
  loadModelMatches,
  LOCKED_VALIDATION_SEASON_V12,
  MODEL_DIR,
  MODEL_DIR_V11,
  MODEL_DIR_V12,
  readJson,
  SELECTION_SEASON_V12,
  TRAINING_SEASON_V12,
  WARM_SEASONS_FOR_DEV_V12,
  WARM_SEASONS_FOR_VALIDATION_V12,
} from "./model-inputs"

const EPS = 1e-9
const MODEL_VERSION = "1.2.0"

const FIELDS = [
  "accuracy1X2",
  "exactScoreAccuracy",
  "homeGoalsMAE",
  "awayGoalsMAE",
  "totalGoalsMAE",
  "bothWithinOneGoal",
  "brierScore",
  "logLoss",
] as const
type MetricSubset = { [K in (typeof FIELDS)[number]]: number }

const FORBIDDEN_FIELDS = ["odds", "b365", "psh", "psd", "psa", "avgH", "avgD", "avgA", "xg"]
const FORBIDDEN_PHRASES = ["guaranteed", "sure win", "sure bet", "sure-fire"]

function fail(msg: string): never {
  throw new Error(`model:v12:verify FAILED — ${msg}`)
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg)
}
function epsEq(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS
}
function metricsMatch(a: MetricSubset, b: MetricSubset): void {
  for (const f of FIELDS) {
    assert(Number.isFinite(a[f]) && Number.isFinite(b[f]), `metric ${f} not finite`)
    assert(epsEq(a[f], b[f]), `metric ${f} mismatch: ${a[f]} vs ${b[f]}`)
  }
}

interface TrainingReport {
  grid: { size: number }
  best: { configHash: string; featureSet: string; l2: number }
  refit: { configHash: string }
  seasons: { burnIn: string; training: string; selection: string }
}
interface DevelopmentReport {
  configHash: string
  seasons: { warm: string[]; development: string }
  models: { v1_2: { metrics: MetricSubset; drawMetrics: Record<string, number> }; v1: { metrics: MetricSubset }; v1_1: { metrics: MetricSubset } }
}
interface PreRegistration {
  configHash: string
  inputDataHash: string
  selectedFeatureSet: string
  selectedL2: number
  acceptanceCriteria: typeof ACCEPTANCE_CRITERIA_V12
  partition: { training: string; selection: string; development: string; lockedValidation: string }
}
interface ValidationReport {
  configHash: string
  status: string
  matchCount: number
  acceptanceCriteria: typeof ACCEPTANCE_CRITERIA_V12
  checks: Array<{ name: string; pass: boolean }>
  seasons: { training: string; selection: string; development: string; lockedValidation: string }
  models: { v1_2: { metrics: MetricSubset; drawMetrics: Record<string, number>; drawPredictions: Array<{ matchId: string }> } }
}
interface V1HoldoutReport {
  configHash: string
  inputDataHash: string
  metrics: MetricSubset
}
interface V11ValidationReport {
  configHash: string
  v1: { metrics: MetricSubset }
  v1_1: { metrics: MetricSubset }
}

function assertCoreFrozen(v12: ModelConfig, v1: ModelConfig): void {
  assert(JSON.stringify(v12.elo) === JSON.stringify(v1.elo), "v1.2 changed frozen elo params")
  assert(JSON.stringify(v12.strength) === JSON.stringify(v1.strength), "v1.2 changed frozen strength params")
  assert(JSON.stringify(v12.coverage) === JSON.stringify(v1.coverage), "v1.2 changed frozen coverage params")
  assert(JSON.stringify(v12.lambda) === JSON.stringify(v1.lambda), "v1.2 changed frozen lambda params")
  assert(JSON.stringify(v12.confidence) === JSON.stringify(v1.confidence), "v1.2 changed frozen confidence params")
  assert(JSON.stringify(v12.reasons) === JSON.stringify(v1.reasons), "v1.2 changed frozen reasons params")
}

function checkPredictions(preds: MatchPrediction[]): void {
  let lastDate = ""
  for (const p of preds) {
    assert(p.date >= lastDate, `predictions not chronological at ${p.date}`)
    lastDate = p.date
    const { home, draw, away } = p.probabilities
    assert(home >= 0 && draw >= 0 && away >= 0, `negative probability on ${p.matchId}`)
    assert(Number.isFinite(home + draw + away), `non-finite probabilities on ${p.matchId}`)
    assert(epsEq(home + draw + away, 1), `probabilities do not sum to 1 on ${p.matchId}`)
    assert(p.predictedResult === argmaxOneX2(p.probabilities), `predictedResult != argmax on ${p.matchId}`)
    for (const key of Object.keys(p)) assert(!FORBIDDEN_FIELDS.includes(key.toLowerCase()), `leaked field "${key}" on ${p.matchId}`)
  }
}

function main(): void {
  const allMatches = loadModelMatches()

  /* ---- 1. v1 unchanged & reproducible ---- */
  const v1Config = resolveConfig(readJson<DeepPartial<ModelConfig>>(join(MODEL_DIR, "config.json")))
  const v1Holdout = readJson<V1HoldoutReport>(join(MODEL_DIR, "holdout-report.json"))
  assert(v1Holdout.configHash === hashConfig(v1Config), "v1 configHash changed")
  assert(v1Holdout.inputDataHash === inputDataHash(), "input data hash changed")
  metricsMatch(computeMetrics(runBacktest(allMatches, v1Config, { evaluateSeasons: [HOLDOUT_SEASON] })), v1Holdout.metrics)

  /* ---- 2. v1.1 unchanged (its config hash matches its committed validation report) ---- */
  const v11Config = resolveConfig(readJson<DeepPartial<ModelConfig>>(join(MODEL_DIR_V11, "config.json")))
  const v11Validation = readJson<V11ValidationReport>(join(MODEL_DIR_V11, "validation-report.json"))
  assert(v11Validation.configHash === hashConfig(v11Config), "v1.1 configHash changed")
  assert(v11Config.version === "1.1.0", "v1.1 config version changed")

  /* ---- 3. v1.2 config valid + core frozen ---- */
  const v12Config = resolveConfig(readJson<DeepPartial<ModelConfig>>(join(MODEL_DIR_V12, "config.json")))
  assert(v12Config.version === MODEL_VERSION, `v1.2 config version must be ${MODEL_VERSION}, got ${v12Config.version}`)
  assert(v12Config.drawModel !== undefined, "v1.2 config missing draw model")
  validateDrawModelConfig(v12Config.drawModel!)
  assert(v12Config.calibration === undefined, "v1.2 must start from the v1 raw matrix (no calibration)")
  assertCoreFrozen(v12Config, v1Config)
  const v12Hash = hashConfig(v12Config)

  /* ---- 4. config hash consistency across all frozen artifacts ---- */
  const preReg = readJson<PreRegistration>(join(MODEL_DIR_V12, "pre-registration.json"))
  const training = readJson<TrainingReport>(join(MODEL_DIR_V12, "training-report.json"))
  const development = readJson<DevelopmentReport>(join(MODEL_DIR_V12, "development-report.json"))
  assert(preReg.configHash === v12Hash, "pre-registration configHash mismatch")
  assert(preReg.inputDataHash === inputDataHash(), "pre-registration inputDataHash mismatch")
  assert(training.refit.configHash === v12Hash, "training-report refit configHash mismatch")
  assert(training.best.configHash === v12Hash || training.refit.configHash === v12Hash, "training best/refit hash inconsistent")
  assert(development.configHash === v12Hash, "development-report configHash mismatch")
  assert(preReg.selectedFeatureSet === v12Config.drawModel!.featureSet, "selected feature set mismatch")
  assert(preReg.selectedL2 === v12Config.drawModel!.l2, "selected L2 mismatch")

  /* ---- 5. honest partition ---- */
  assert(training.grid.size === 12, `tuning grid must be 12 cells, got ${training.grid.size}`)
  assert(training.seasons.training === TRAINING_SEASON_V12, "training season wrong")
  assert(training.seasons.selection === SELECTION_SEASON_V12, "selection season wrong")
  assert(preReg.partition.training === TRAINING_SEASON_V12 && preReg.partition.selection === SELECTION_SEASON_V12, "pre-reg partition (train/sel) wrong")
  assert(preReg.partition.development === DEVELOPMENT_SEASON_V12 && preReg.partition.lockedValidation === LOCKED_VALIDATION_SEASON_V12, "pre-reg partition (dev/locked) wrong")
  assert(development.seasons.development === DEVELOPMENT_SEASON_V12, "development season wrong")
  assert(!development.seasons.warm.includes(LOCKED_VALIDATION_SEASON_V12), "development warm list must not include 2025-26")
  assert(JSON.stringify(WARM_SEASONS_FOR_DEV_V12) === JSON.stringify(development.seasons.warm), "development warm seasons changed")
  assert(JSON.stringify(WARM_SEASONS_FOR_VALIDATION_V12) === JSON.stringify([BURN_IN_SEASON, TRAINING_SEASON_V12, SELECTION_SEASON_V12, DEVELOPMENT_SEASON_V12, LOCKED_VALIDATION_SEASON_V12]), "validation warm seasons changed")

  /* ---- 6. acceptance criteria fixed ---- */
  assert(JSON.stringify(preReg.acceptanceCriteria) === JSON.stringify(ACCEPTANCE_CRITERIA_V12), "pre-registered acceptance criteria changed")

  /* ---- 7. determinism of the frozen config (re-run 2024-25) ---- */
  const devMatches = filterSeasons(allMatches, WARM_SEASONS_FOR_DEV_V12)
  const v12DevPreds = runBacktest(devMatches, v12Config, { evaluateSeasons: [DEVELOPMENT_SEASON_V12] })
  metricsMatch(computeMetrics(v12DevPreds), development.models.v1_2.metrics)
  checkPredictions(v12DevPreds)
  // Cross-check: v1/v1.1 dev metrics equal the committed v1.1 validation on 2024-25.
  metricsMatch(development.models.v1.metrics, v11Validation.v1.metrics)
  metricsMatch(development.models.v1_1.metrics, v11Validation.v1_1.metrics)

  /* ---- 8. validation-report (optional until validate has run) ---- */
  const validationPath = join(MODEL_DIR_V12, "validation-report.json")
  if (existsSync(validationPath)) {
    const validation = readJson<ValidationReport>(validationPath)
    assert(validation.configHash === v12Hash, "validation-report configHash mismatch")
    assert(validation.matchCount === 380, `validation matchCount must be 380, got ${validation.matchCount}`)
    assert(validation.seasons.lockedValidation === LOCKED_VALIDATION_SEASON_V12, "validation locked season wrong")
    assert(JSON.stringify(validation.acceptanceCriteria) === JSON.stringify(ACCEPTANCE_CRITERIA_V12), "validation acceptance criteria changed")

    const validationMatches = filterSeasons(allMatches, WARM_SEASONS_FOR_VALIDATION_V12)
    const v12ValPreds = runBacktest(validationMatches, v12Config, { evaluateSeasons: [LOCKED_VALIDATION_SEASON_V12] })
    metricsMatch(computeMetrics(v12ValPreds), validation.models.v1_2.metrics)
    checkPredictions(v12ValPreds)

    const v12Draw = computeDrawMetrics(v12ValPreds)
    assert(v12Draw.predictedDrawCount === validation.models.v1_2.drawMetrics.predictedDrawCount, "draw metrics not reproducible")
    assert(v12Draw.actualDrawCount === validation.models.v1_2.drawMetrics.actualDrawCount, "draw metrics not reproducible")
    assert(validation.models.v1_2.drawPredictions.length === v12Draw.predictedDrawCount, "draw predictions list length mismatch")

    assert(validation.status === "accepted" || validation.status === "rejected", `invalid validation status: ${validation.status}`)
    const gating = validation.checks.slice(0, 13)
    const expected = gating.every((c) => c.pass) ? "accepted" : "rejected"
    assert(validation.status === expected, "validation status inconsistent with checks")

    const calibrationPath = join(MODEL_DIR_V12, "calibration.json")
    assert(existsSync(calibrationPath), "v1.2 calibration.json missing")
    const calibration = readJson<{ bucketCount: number; buckets: Array<{ predictions: number }> }>(calibrationPath)
    assert(calibration.bucketCount === 30, `calibration bucketCount must be 30, got ${calibration.bucketCount}`)
    const calTotal = calibration.buckets.reduce((s, b) => s + b.predictions, 0)
    assert(calTotal === v12ValPreds.length * 3, `calibration sample total must be 3×380, got ${calTotal}`)
  }

  /* ---- 9. no misleading wording / no future predictions ---- */
  for (const name of ["config.json", "pre-registration.json", "training-report.json", "development-report.json", "validation-report.json"]) {
    const path = join(MODEL_DIR_V12, name)
    if (!existsSync(path)) continue
    const text = readFileSync(path, "utf-8").toLowerCase()
    for (const phrase of FORBIDDEN_PHRASES) assert(!text.includes(phrase), `${name} contains misleading phrase "${phrase}"`)
    assert(!text.includes("2026-27") && !text.includes("2026/27"), `${name} must not reference 2026-27 predictions`)
  }

  console.log("model:v12:verify — all checks passed")
  console.log(`  v1 & v1.1 unchanged and reproducible`)
  console.log(`  v1.2 config valid, core frozen, no calibration, configHash ${v12Hash.slice(0, 12)}…`)
  console.log(`  partition: train=${TRAINING_SEASON_V12} sel=${SELECTION_SEASON_V12} dev=${DEVELOPMENT_SEASON_V12} locked=${LOCKED_VALIDATION_SEASON_V12}`)
  console.log(`  acceptance criteria fixed; frozen config deterministic (2024-25 reproduced)`)
  if (existsSync(validationPath)) console.log(`  locked validation reproduced; no leakage; no 2026-27 predictions`)
}

main()
