/**
 * Read-only loader for the bits of `data/football/*.json` that identify the
 * Premier League season. Shared by the sync client, the sync engine, the verify
 * script and the evaluation layer so the season is derived from committed data
 * in exactly one place — never scattered as hardcoded constants.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { Competition, Fixture } from "../supabase/types"

export interface StaticConfig {
  /** Internal competition id (UUID) of the Premier League row. */
  competitionId: string
  competitionSlug: string
  /** Calendar year the season starts — the football-data.org `season` param. */
  season: number
  /** Human season label used by the prediction artifacts, e.g. `2026-27`. */
  seasonLabel: string
  providerCompetitionId: number
}

const PREMIER_LEAGUE_SLUG = "premier-league"

export function loadStaticConfig(root: string = process.cwd()): StaticConfig {
  const dataDir = join(root, "data", "football")
  const competitions = JSON.parse(readFileSync(join(dataDir, "competitions.json"), "utf8")) as Competition[]
  const pl = competitions.find((c) => c.slug === PREMIER_LEAGUE_SLUG)
  if (!pl) {
    throw new Error(`static config: competition "${PREMIER_LEAGUE_SLUG}" not found in data/football/competitions.json`)
  }
  if (typeof pl.current_season !== "number" || !Number.isInteger(pl.current_season)) {
    throw new Error(`static config: ${PREMIER_LEAGUE_SLUG} has no integer current_season`)
  }
  const season = pl.current_season
  const shortYear = (season + 1) % 100
  return {
    competitionId: pl.id,
    competitionSlug: pl.slug,
    season,
    seasonLabel: `${season}-${String(shortYear).padStart(2, "0")}`,
    providerCompetitionId: pl.provider_competition_id,
  }
}

export function loadLocalFixtureCount(root: string = process.cwd()): number {
  const fixtures = JSON.parse(
    readFileSync(join(root, "data", "football", "fixtures.json"), "utf8"),
  ) as Fixture[]
  return fixtures.length
}
