/**
 * Shared input loading + train/eval split for the prediction-model scripts.
 * Reads the normalized history JSON (produced by `history:import`) and maps it
 * into the model's minimal `ModelMatch` shape. No runtime clock, no network.
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { HISTORY_SEASONS } from "../lib/football/history-seasons"
import type { HistoryMatch } from "../lib/football/history-normalize"
import type { ModelMatch } from "../lib/model/types"

export const BURN_IN_SEASON = "2021-22"
export const TUNING_SEASONS = ["2022-23", "2023-24", "2024-25"]
export const HOLDOUT_SEASON = "2025-26"
export const ALL_SEASONS = HISTORY_SEASONS.map((s) => s.season)

// v1.1 re-partitions the data honestly: 2025-26 was already observed while
// building v1, so it is no longer an untouched holdout. v1.1 selects parameters
// on 2022-23 + 2023-24, accepts/rejects on 2024-25, and compares on 2025-26 as
// an exposed, post-hoc set only.
export const TUNING_SEASONS_V11 = ["2022-23", "2023-24"]
export const VALIDATION_SEASON_V11 = "2024-25"
export const EXPOSED_SEASON_V11 = "2025-26"

// v1.2 re-partitions honestly: 2024-25 was already observed while building
// v1.1, so it is an exposed development benchmark (never used for selection);
// 2025-26 is the single locked validation season, run exactly once after the
// config is frozen and pre-registered.
export const MODEL_VERSION_V12 = "1.2.0"
export const TRAINING_SEASON_V12 = "2022-23"
export const SELECTION_SEASON_V12 = "2023-24"
export const DEVELOPMENT_SEASON_V12 = "2024-25"
export const LOCKED_VALIDATION_SEASON_V12 = "2025-26"
/** Seasons warmed before the 2024-25 development benchmark (never labels). */
export const WARM_SEASONS_FOR_DEV_V12 = [BURN_IN_SEASON, TRAINING_SEASON_V12, SELECTION_SEASON_V12, DEVELOPMENT_SEASON_V12]
/** All five seasons, warmed before the 2025-26 locked validation. */
export const WARM_SEASONS_FOR_VALIDATION_V12 = [BURN_IN_SEASON, TRAINING_SEASON_V12, SELECTION_SEASON_V12, DEVELOPMENT_SEASON_V12, LOCKED_VALIDATION_SEASON_V12]

export const V12_FEATURE_SETS = ["A", "B", "C"] as const
export const V12_L2_VALUES = [0.01, 0.1, 1, 10]

/**
 * v1.2 acceptance criteria — fixed BEFORE 2025-26 is ever run (§八). The tune
 * script writes these verbatim into pre-registration.json; the validate script
 * applies them; the verify script asserts the pre-registration still matches.
 */
export const ACCEPTANCE_CRITERIA_V12 = {
  // probability & structure
  probSumTolerance: 1e-6,
  // draw performance (per 380-match season)
  minPredictedDraws: 19, // ≥ 5%
  maxPredictedDraws: 133, // ≤ 35%
  minDrawRecall: 0.1,
  minDrawPrecision: 0.2,
  minDrawF1: 0.13,
  minDrawProbGap: 0.01, // avg draw prob on draws − on non-draws must exceed this
  drawBrierTolerance: 0.005, // vs v1 same season
  // overall vs v1 (same season)
  logLossTolerance: 0.01,
  brierTolerance: 0.01,
  accuracyTolerance: 0.02, // 2 percentage points
  // degeneracy / confidence sanity
  minDistinctOutcomes: 2,
  minHighConfidenceSamples: 10, // below this, high-confidence accuracy is not claimed stable
  confidenceTolerance: 0.03,
} as const

export const HISTORY_DIR = join(process.cwd(), "data", "history", "premier-league")
export const MODEL_DIR = join(process.cwd(), "data", "model", "premier-league", "v1")
export const MODEL_DIR_V11 = join(process.cwd(), "data", "model", "premier-league", "v1.1")
export const MODEL_DIR_V12 = join(process.cwd(), "data", "model", "premier-league", "v1.2")

/** Map a normalized history match into the model's minimal match shape. */
export function toModelMatch(h: HistoryMatch): ModelMatch {
  return {
    id: h.id,
    season: h.season,
    date: h.date,
    homeSlug: h.homeTeam.slug,
    awaySlug: h.awayTeam.slug,
    homeGoals: h.fullTime.home,
    awayGoals: h.fullTime.away,
  }
}

/** Load every normalized season and map to `ModelMatch[]`. */
export function loadModelMatches(): ModelMatch[] {
  const out: ModelMatch[] = []
  for (const spec of HISTORY_SEASONS) {
    const path = join(HISTORY_DIR, "normalized", `${spec.season}.json`)
    const matches = JSON.parse(readFileSync(path, "utf-8")) as HistoryMatch[]
    for (const m of matches) out.push(toModelMatch(m))
  }
  return out
}

/** Keep only the given seasons (preserving order), for honest data partitioning. */
export function filterSeasons(matches: ModelMatch[], seasons: string[]): ModelMatch[] {
  const set = new Set(seasons)
  return matches.filter((m) => set.has(m.season))
}

/** SHA-256 over the raw normalized JSON (concatenated in season order). */
export function inputDataHash(): string {
  const hash = createHash("sha256")
  for (const spec of HISTORY_SEASONS) {
    const path = join(HISTORY_DIR, "normalized", `${spec.season}.json`)
    hash.update(readFileSync(path))
  }
  return hash.digest("hex")
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T
}
