/**
 * Validated Premier League fixtures client.
 *
 * Thin layer over the existing `lib/football-data/client.ts` HTTP client (which
 * already owns timeout, 401/403, 429 `Retry-After`, bounded retries and reads
 * the token from `FOOTBALL_DATA_API_KEY` only). This module adds the two things
 * the sync needs that the raw client does not:
 *
 *   1. the season is derived from committed `data/football/competitions.json`
 *      (never hardcoded), and
 *   2. the returned payload is shape-validated (non-empty, correct count,
 *      no duplicates, known statuses, complete final scores) before it is
 *      handed to the sync engine.
 *
 * An `offline` source is accepted so tests and `--source-file` runs never touch
 * the network or a real token.
 */

import { getCompetitionMatches } from "../football-data/client"
import type { Match } from "../football-data/types"

import { validateMatches } from "./fixture-validation"
import { loadLocalFixtureCount, loadStaticConfig, type StaticConfig } from "./static-config"

export interface FetchPremierLeagueMatchesOptions {
  /** Offline payload used instead of a live API call (tests / --source-file). */
  offlineMatches?: unknown
  /** Exact expected fixture count; defaults to the committed local count. */
  expectedCount?: number
  /** Static config; defaults to the committed snapshot. */
  config?: StaticConfig
}

/**
 * Fetch (or accept an offline copy of) the full PL fixture list and validate it.
 *
 * @returns The validated `Match[]`, guaranteed non-empty and exactly the
 *          expected count.
 */
export async function fetchPremierLeagueMatches(
  options: FetchPremierLeagueMatchesOptions = {},
): Promise<Match[]> {
  const config = options.config ?? loadStaticConfig()
  const expectedCount = options.expectedCount ?? loadLocalFixtureCount()

  let raw: unknown
  if (options.offlineMatches !== undefined) {
    raw = options.offlineMatches
  } else {
    raw = await getCompetitionMatches("PL", config.season)
  }

  return validateMatches(raw, expectedCount)
}
