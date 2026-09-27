#!/usr/bin/env tsx
/**
 * Premier League prediction settlement CLI (`predictions:pl:evaluate`).
 *
 * Reads the frozen prediction artifacts and the current fixture snapshot, then
 * writes the settlement overlay to `data/evaluations/premier-league/2026-27/` —
 * a directory that is deliberately separate from the sealed prediction
 * directory, so the predictions themselves are never touched.
 *
 * The evaluation is deterministic given its inputs: `evaluatedAt` is derived
 * from the result-data cutoff (not the wall clock), so repeated runs over
 * unchanged data produce byte-identical output and never churn the commit diff.
 *
 * No network I/O. The prediction, model, history and synced directories are
 * read-only here.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { loadLocalSnapshot } from "../lib/football/fixture-sync"
import { loadStaticConfig } from "../lib/football/static-config"
import { transactionalWrite } from "../lib/football/transactional-write"
import type { PredictionArtifact } from "../lib/model/prediction-artifact"
import type { EffectiveCatalogFile, EligibilityOverridesFile } from "../lib/predictions/prediction-classification"
import { hashObject, type RemainingFutureSealedFile } from "../lib/predictions/prediction-lock"
import { computeEvaluation } from "../lib/predictions/prediction-evaluation"
import { gitRevParse } from "./historical-inputs"

const PREDICTIONS_DIR = join(process.cwd(), "data", "predictions", "premier-league", "2026-27")
const CURRENT_EVAL_REL = join("data", "evaluations", "premier-league", "2026-27", "current-evaluation.json")
const EVAL_MANIFEST_REL = join("data", "evaluations", "premier-league", "2026-27", "evaluation-manifest.json")

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

interface EvaluationManifest {
  schemaVersion: 1
  competitionSlug: string
  season: string
  evaluatedAt: string
  sourceCommit: string
  inputHashes: {
    predictions: string
    sealedPredictions: string
    eligibilityOverrides: string
    effectiveCatalog: string
    fixtures: string
  }
  result: {
    publishedPredictionCount: number
    officialEvaluatedCount: number
    officialAccuracy: number | null
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Commit the settlement overlay (`current-evaluation.json` +
 * `evaluation-manifest.json`) as one transaction. The two files must agree on
 * `evaluatedAt`/`season` or neither lands — a half-written settlement would
 * otherwise let the build read a stale manifest against a new evaluation.
 */
function writeEvaluationTransaction(result: unknown, manifest: unknown): void {
  const evalText = stableJson(result)
  const manifestText = stableJson(manifest)

  transactionalWrite({
    root: process.cwd(),
    files: [
      { relativePath: CURRENT_EVAL_REL, content: evalText },
      { relativePath: EVAL_MANIFEST_REL, content: manifestText },
    ],
    validate: (files) => {
      const evalDoc = JSON.parse(files.get(CURRENT_EVAL_REL) ?? "{}") as { evaluatedAt?: string; season?: string }
      const manifestDoc = JSON.parse(files.get(EVAL_MANIFEST_REL) ?? "{}") as { evaluatedAt?: string; season?: string }
      if (evalDoc.evaluatedAt !== manifestDoc.evaluatedAt) {
        throw new Error(`evaluation evaluatedAt ${evalDoc.evaluatedAt} != manifest ${manifestDoc.evaluatedAt}`)
      }
      if (evalDoc.season !== manifestDoc.season) {
        throw new Error(`evaluation season ${evalDoc.season} != manifest ${manifestDoc.season}`)
      }
    },
  })
}

function main(): void {
  const config = loadStaticConfig()
  const snapshot = loadLocalSnapshot()
  const plFixtures = snapshot.fixtures.filter((f) => f.competition_id === config.competitionId)

  const predictions = readJson<PredictionArtifact[]>(join(PREDICTIONS_DIR, "predictions.json"))
  const sealed = readJson<RemainingFutureSealedFile>(join(PREDICTIONS_DIR, "sealed-predictions.json"))
  const overrides = readJson<EligibilityOverridesFile>(join(PREDICTIONS_DIR, "eligibility-overrides.json"))
  const catalog = readJson<EffectiveCatalogFile>(join(PREDICTIONS_DIR, "effective-prediction-catalog.json"))

  const resultDataCutoff = snapshot.manifest.sourceLastUpdatedAt
  const predictionDataCutoff = predictions[0]?.dataCutoff ?? null
  const evaluatedAt = resultDataCutoff ?? predictionDataCutoff ?? new Date().toISOString()

  const result = computeEvaluation({
    predictions,
    sealed,
    overrides,
    catalog,
    fixtures: plFixtures,
    competitionSlug: config.competitionSlug,
    season: config.seasonLabel,
    evaluatedAt,
    resultDataCutoff,
  })

  let sourceCommit = "unavailable"
  try {
    sourceCommit = gitRevParse("HEAD")
  } catch {
    // non-git checkout; provenance is best-effort
  }

  const manifest: EvaluationManifest = {
    schemaVersion: 1,
    competitionSlug: config.competitionSlug,
    season: config.seasonLabel,
    evaluatedAt,
    sourceCommit,
    inputHashes: {
      predictions: hashObject(predictions),
      sealedPredictions: hashObject(sealed),
      eligibilityOverrides: hashObject(overrides),
      effectiveCatalog: hashObject(catalog),
      fixtures: hashObject(plFixtures),
    },
    result: {
      publishedPredictionCount: result.categories.officialSealed.publishedCount,
      officialEvaluatedCount: result.categories.officialSealed.officialEvaluatedCount,
      officialAccuracy: result.categories.officialSealed.officialAccuracy,
    },
  }

  writeEvaluationTransaction(result as unknown as Record<string, unknown>, manifest as unknown as Record<string, unknown>)

  const c = result.categories
  console.log(`predictions:pl:evaluate — settlement written to data/evaluations/premier-league/2026-27/`)
  console.log(`  fixture status: ${result.fixtureStatus.finished} finished / ${result.fixtureStatus.notStarted} not started`)
  console.log(`  A original backtest:      ${c.originalBacktest.sampleCount} (never official)`)
  console.log(`  B historical reconstruction: ${c.historicalReconstruction.sampleCount} (never official, ${c.historicalReconstruction.settledCount} settled)`)
  console.log(
    `  C official sealed:        ${c.officialSealed.candidateCount} candidates, ` +
      `${c.officialSealed.publishedCount} published, ` +
      `${c.officialSealed.officialEvaluatedCount} official, ` +
      `accuracy=${c.officialSealed.officialAccuracy === null ? "null" : c.officialSealed.officialAccuracy}`,
  )
}

main()
