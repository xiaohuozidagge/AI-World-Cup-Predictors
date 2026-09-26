/**
 * Historical input recovery for prediction verification.
 *
 * `predictions:pl:verify` originally re-derived the generation-time
 * `inputDataHash` from the *current* `data/football/*.json`. That broke the
 * moment the Champions League was removed from the live snapshot (524 → 380
 * fixtures): the hash is a fingerprint of the exact inputs the predictions were
 * generated from, so it must be recomputed from the provenance commit recorded
 * in the prediction manifest — never from today's pruned files.
 *
 * This module recovers all nine generation inputs — the five normalized
 * history seasons plus the four football snapshot files — from
 * `git show <commit>:<path>` using
 * `execFileSync` (arguments are passed directly to git as an argv array, never
 * through a shell, so a hostile commit string cannot be injected), and keeps the
 * current-snapshot checks — no Champions League, every PL fixture maps — as a
 * *separate* concern with their own distinguishable error codes.
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { HISTORY_SEASONS } from "../lib/football/history-seasons"
import { sha256Hex } from "../lib/model/prediction-artifact"

// --- distinguishable error codes --------------------------------------------

export const HISTORICAL_SOURCE_COMMIT_UNAVAILABLE = "HISTORICAL_SOURCE_COMMIT_UNAVAILABLE"
export const HISTORICAL_INPUT_HASH_MISMATCH = "HISTORICAL_INPUT_HASH_MISMATCH"
export const CURRENT_PL_MAPPING_MISMATCH = "CURRENT_PL_MAPPING_MISMATCH"
export const CHAMPIONS_LEAGUE_RUNTIME_DATA_PRESENT = "CHAMPIONS_LEAGUE_RUNTIME_DATA_PRESENT"

export class HistoricalVerificationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "HistoricalVerificationError"
    this.code = code
  }
}

// --- read-only git plumbing (execFileSync — no shell, no injection) ---------

const ROOT = process.cwd()
const FOOTBALL_DIR = join(ROOT, "data", "football")

/** Full Git object id: SHA-1 (40 hex) or SHA-256 (64 hex). */
const FULL_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/

export function isFullGitSha(value: string): boolean {
  return FULL_SHA_RE.test(value)
}

export function gitRevParse(rev: string): string {
  return execFileSync("git", ["rev-parse", "--verify", rev], { cwd: ROOT, encoding: "utf8" }).trim()
}

export function commitExists(commit: string): boolean {
  if (!isFullGitSha(commit)) return false
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: ROOT, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

export function isAncestorOrSelf(ancestor: string, head: string): boolean {
  if (ancestor === head) return true
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, head], { cwd: ROOT, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

export function gitShowBlob(commit: string, repoPath: string): Buffer {
  try {
    return execFileSync("git", ["show", `${commit}:${repoPath}`], {
      cwd: ROOT,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    throw new HistoricalVerificationError(
      HISTORICAL_SOURCE_COMMIT_UNAVAILABLE,
      `historical input file missing at ${commit}:${repoPath}`,
    )
  }
}

/**
 * Assert the provenance commit is a legal full Git SHA, exists in the
 * repository, and is an ancestor of (or equal to) `head`. Throws
 * `HISTORICAL_SOURCE_COMMIT_UNAVAILABLE` on any of those failures.
 */
export function validateProvenanceCommit(commit: string, head: string): void {
  if (!isFullGitSha(commit)) {
    throw new HistoricalVerificationError(
      HISTORICAL_SOURCE_COMMIT_UNAVAILABLE,
      `provenance commit is not a full Git SHA: ${JSON.stringify(commit)}`,
    )
  }
  if (!commitExists(commit)) {
    throw new HistoricalVerificationError(
      HISTORICAL_SOURCE_COMMIT_UNAVAILABLE,
      `provenance commit does not exist: ${commit}`,
    )
  }
  if (!isAncestorOrSelf(commit, head)) {
    throw new HistoricalVerificationError(
      HISTORICAL_SOURCE_COMMIT_UNAVAILABLE,
      `provenance commit ${commit} is not an ancestor of HEAD ${head}`,
    )
  }
}

// --- hashing ----------------------------------------------------------------

/**
 * Repo-relative paths of every input the generation-time `inputDataHash`
 * covered, in the exact order `prediction-inputs.ts#computeInputDataHash`
 * hashed them: the five normalized history seasons, then the four football
 * snapshot files. That file is in `GENERATOR_SOURCE_FILES` and cannot be
 * modified, so this list is mirrored here deliberately rather than imported.
 */
export const HISTORICAL_INPUT_PATHS: readonly string[] = [
  ...HISTORY_SEASONS.map((spec) => `data/history/premier-league/normalized/${spec.season}.json`),
  "data/football/competitions.json",
  "data/football/teams.json",
  "data/football/fixtures.json",
  "data/football/manifest.json",
]

/**
 * Recompute the generation-time `inputDataHash` from the recorded commit.
 * Every input is read from that single commit via `git show <commit>:<path>`,
 * so the result is reproducible from provenance alone and never depends on
 * today's working tree (whose football files are pruned to 380 fixtures and
 * whose history files are only incidentally identical).
 */
export function computeHistoricalInputDataHash(commit: string): string {
  return sha256Hex(...HISTORICAL_INPUT_PATHS.map((path) => gitShowBlob(commit, path)))
}

/**
 * Assert the recomputed historical `inputDataHash` equals the stored one.
 * Throws `HISTORICAL_INPUT_HASH_MISMATCH` when any input content differs.
 */
export function assertHistoricalInputHashMatches(commit: string, storedHash: string): void {
  const computed = computeHistoricalInputDataHash(commit)
  if (computed !== storedHash) {
    throw new HistoricalVerificationError(
      HISTORICAL_INPUT_HASH_MISMATCH,
      `historical inputDataHash ${computed} does not match stored ${storedHash}`,
    )
  }
}

// --- current-publication checks (separate from historical integrity) --------

interface CompetitionRef {
  id: string
  slug: string
}
interface FixtureRef {
  id: string
  competition_id: string
  home_team_id: string
  away_team_id: string
  status: string
  fulltime_home_score: number | null
  fulltime_away_score: number | null
}

export function readCurrentCompetitions(): CompetitionRef[] {
  return JSON.parse(readFileSync(join(FOOTBALL_DIR, "competitions.json"), "utf8")) as CompetitionRef[]
}

/**
 * Fail if the current snapshot still carries Champions League runtime data —
 * either a "champions-league" competition or any fixture that does not belong to
 * the Premier League competition id.
 */
export function assertNoChampionsLeagueRuntimeData(
  competitions: readonly CompetitionRef[],
  fixtures: readonly FixtureRef[],
  plCompetitionId: string,
): void {
  const cl = competitions.find((c) => c.slug === "champions-league")
  if (cl) {
    throw new HistoricalVerificationError(
      CHAMPIONS_LEAGUE_RUNTIME_DATA_PRESENT,
      `competition "champions-league" (id ${cl.id}) is present in current data`,
    )
  }
  const nonPl = fixtures.find((f) => f.competition_id !== plCompetitionId)
  if (nonPl) {
    throw new HistoricalVerificationError(
      CHAMPIONS_LEAGUE_RUNTIME_DATA_PRESENT,
      `fixture ${nonPl.id} references non-Premier-League competition ${nonPl.competition_id}`,
    )
  }
}

/**
 * Fail if any current Premier League fixture cannot be mapped into a prediction:
 * it references an unknown team, names the same side home and away, or carries a
 * status/score that cannot be resolved to backtest-vs-candidate.
 */
export function assertCurrentPlMappingValid(
  fixtures: readonly FixtureRef[],
  teamIds: ReadonlySet<string>,
  plCompetitionId: string,
): void {
  for (const f of fixtures) {
    if (f.competition_id !== plCompetitionId) continue
    if (!teamIds.has(f.home_team_id)) {
      throw new HistoricalVerificationError(
        CURRENT_PL_MAPPING_MISMATCH,
        `fixture ${f.id} references unknown home team ${f.home_team_id}`,
      )
    }
    if (!teamIds.has(f.away_team_id)) {
      throw new HistoricalVerificationError(
        CURRENT_PL_MAPPING_MISMATCH,
        `fixture ${f.id} references unknown away team ${f.away_team_id}`,
      )
    }
    if (f.home_team_id === f.away_team_id) {
      throw new HistoricalVerificationError(CURRENT_PL_MAPPING_MISMATCH, `fixture ${f.id} has home == away`)
    }
    const hasResult = f.fulltime_home_score !== null && f.fulltime_away_score !== null
    if (hasResult !== (f.status === "FINISHED")) {
      throw new HistoricalVerificationError(
        CURRENT_PL_MAPPING_MISMATCH,
        `fixture ${f.id}: status/score inconsistency (status=${f.status}, hasResult=${hasResult})`,
      )
    }
  }
}
