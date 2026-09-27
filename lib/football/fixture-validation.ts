/**
 * Pure validation of a football-data.org v4 `matches` payload before it is
 * allowed anywhere near the static fixture snapshot.
 *
 * The existing client (`lib/football-data/client.ts`) already handles the HTTP
 * concerns — timeout, 401/403, 429 `Retry-After`, bounded retries, token-only-
 * from-env. This module adds the *shape* gate the sync layer needs: it rejects
 * empty, malformed, incomplete, duplicate, wrong-count and unknown-status
 * responses so that a bad payload can never half-apply against `data/football`.
 *
 * Everything here is a plain function over the v4 `Match` shape — no I/O, no
 * clock, no `any`. It is deliberately independent of the sync engine so the two
 * can be tested separately.
 */

import type { Match } from "../football-data/types"
import { mapFixtureStatus } from "./status-map"

export type FixtureValidationCode =
  | "EMPTY_MATCHES"
  | "MATCH_COUNT_MISMATCH"
  | "NOT_AN_ARRAY"
  | "DUPLICATE_PROVIDER_ID"
  | "INVALID_MATCH_SHAPE"
  | "INVALID_KICKOFF"
  | "UNKNOWN_STATUS"
  | "SAME_TEAM_BOTH_SIDES"
  | "INCOMPLETE_FINISHED_SCORE"
  | "INVALID_SCORE"

export class FixtureValidationError extends Error {
  readonly code: FixtureValidationCode
  constructor(code: FixtureValidationCode, message: string) {
    super(`${code}: ${message}`)
    this.name = "FixtureValidationError"
    this.code = code
  }
}

/** Statuses the football-data.org v4 API emits for a league fixture. */
const KNOWN_API_STATUSES = new Set([
  "SCHEDULED",
  "TIMED",
  "IN_PLAY",
  "PAUSED",
  "FINISHED",
  "SUSPENDED",
  "POSTPONED",
  "CANCELLED",
  "AWARDED",
])

/** API statuses that carry a final result (→ internal FINISHED). */
const FINAL_API_STATUSES = new Set(["FINISHED", "AWARDED"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value))
}

/** A team reference must carry a numeric provider id and a non-empty name. */
function assertTeamRef(team: unknown, side: string, matchId: unknown): void {
  if (!isRecord(team)) {
    throw new FixtureValidationError("INVALID_MATCH_SHAPE", `match ${String(matchId)} ${side} team is not an object`)
  }
  if (typeof team.id !== "number" || !Number.isInteger(team.id) || team.id <= 0) {
    throw new FixtureValidationError("INVALID_MATCH_SHAPE", `match ${String(matchId)} ${side} team has invalid id`)
  }
  if (typeof team.name !== "string" || team.name.trim() === "") {
    throw new FixtureValidationError("INVALID_MATCH_SHAPE", `match ${String(matchId)} ${side} team has empty name`)
  }
}

/**
 * Validate a raw `matches` payload against the expected season size.
 *
 * @param payload  The untyped payload (an array of v4 match objects).
 * @param expectedCount  The exact number of fixtures the sync requires.
 * @returns The payload narrowed to `Match[]` once every check has passed.
 */
export function validateMatches(payload: unknown, expectedCount: number): Match[] {
  if (!Array.isArray(payload)) {
    throw new FixtureValidationError("NOT_AN_ARRAY", "matches payload is not an array")
  }
  if (payload.length === 0) {
    throw new FixtureValidationError("EMPTY_MATCHES", "matches payload is empty")
  }
  if (payload.length !== expectedCount) {
    throw new FixtureValidationError(
      "MATCH_COUNT_MISMATCH",
      `matches payload has ${payload.length} matches, expected ${expectedCount}`,
    )
  }

  const seenIds = new Set<number>()

  for (const raw of payload) {
    if (!isRecord(raw)) {
      throw new FixtureValidationError("INVALID_MATCH_SHAPE", "a match is not an object")
    }

    const id = raw.id
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      throw new FixtureValidationError("INVALID_MATCH_SHAPE", "a match has an invalid id")
    }
    if (seenIds.has(id)) {
      throw new FixtureValidationError("DUPLICATE_PROVIDER_ID", `duplicate provider match id ${id}`)
    }
    seenIds.add(id)

    if (!isIsoTimestamp(raw.utcDate)) {
      throw new FixtureValidationError("INVALID_KICKOFF", `match ${id} has invalid utcDate ${String(raw.utcDate)}`)
    }

    const status = typeof raw.status === "string" ? raw.status.trim() : ""
    if (!KNOWN_API_STATUSES.has(status)) {
      throw new FixtureValidationError("UNKNOWN_STATUS", `match ${id} has unknown status ${String(raw.status)}`)
    }

    assertTeamRef(raw.homeTeam, "home", id)
    assertTeamRef(raw.awayTeam, "away", id)

    const home = raw.homeTeam as { id: number }
    const away = raw.awayTeam as { id: number }
    if (home.id === away.id) {
      throw new FixtureValidationError("SAME_TEAM_BOTH_SIDES", `match ${id} has the same team home and away`)
    }

    // A final result must carry a complete, non-negative integer full-time score.
    // A non-final status must not be treated as carrying a final score here — the
    // sync engine decides what (if anything) to write.
    if (FINAL_API_STATUSES.has(status)) {
      const score = isRecord(raw.score) ? raw.score : null
      const fullTime = score && isRecord(score.fullTime) ? score.fullTime : null
      if (!fullTime || !isNonNegativeInteger(fullTime.home) || !isNonNegativeInteger(fullTime.away)) {
        throw new FixtureValidationError(
          "INCOMPLETE_FINISHED_SCORE",
          `match ${id} is ${status} but lacks a complete full-time score`,
        )
      }
    }
  }

  // The mapping helper is exercised here for an early, uniform unknown-status
  // signal: it must recognize every status we just admitted. (AWARDED → FINISHED
  // is a deliberate, pre-existing mapping.)
  for (const m of payload as Match[]) {
    mapFixtureStatus(m.status)
  }

  return payload as Match[]
}

export { KNOWN_API_STATUSES, FINAL_API_STATUSES }
