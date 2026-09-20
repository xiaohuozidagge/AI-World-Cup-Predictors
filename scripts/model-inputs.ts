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

export const HISTORY_DIR = join(process.cwd(), "data", "history", "premier-league")
export const MODEL_DIR = join(process.cwd(), "data", "model", "premier-league", "v1")

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
