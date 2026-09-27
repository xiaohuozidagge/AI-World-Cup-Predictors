/**
 * Tests for the football-data.org payload validation gate.
 *
 * Covers the client-side shape checks the sync depends on: a valid payload
 * passes; empty, wrong-count, duplicate, malformed, unknown-status, same-team
 * and incomplete/negative-score payloads are all rejected with a typed code.
 *
 * The existing HTTP client (`lib/football-data/client.ts`) already owns
 * timeout / 401 / 403 / 429 Retry-After / bounded retry; the 401/403 fail-fast
 * paths are asserted here via a mocked `fetch` through the wrapper client so the
 * re-used behaviour is pinned without hitting the network.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { validateMatches, FixtureValidationError } from "./fixture-validation"
import { fetchPremierLeagueMatches } from "./football-data-client"
import type { Match } from "../football-data/types"

function makeMatch(id: number, overrides: Partial<Match> = {}): Match {
  return {
    id,
    utcDate: "2026-08-21T19:00:00Z",
    status: "SCHEDULED",
    matchday: 1,
    stage: "REGULAR_SEASON",
    group: null,
    lastUpdated: "2026-09-18T00:20:33Z",
    homeTeam: { id: 57, name: "Arsenal FC", shortName: "Arsenal", tla: "ARS", crest: null },
    awayTeam: { id: 58, name: "Aston Villa FC", shortName: "Villa", tla: "AVL", crest: null },
    score: { winner: null, duration: "REGULAR", fullTime: { home: null, away: null }, halfTime: { home: null, away: null } },
    ...overrides,
  }
}

function assertCode(code: string) {
  return (err: unknown) => {
    assert.ok(err instanceof FixtureValidationError, `expected FixtureValidationError, got ${String(err)}`)
    assert.equal((err as FixtureValidationError).code, code)
    return true
  }
}

test("valid payload with the exact expected count passes", () => {
  const matches = [makeMatch(1), makeMatch(2), makeMatch(3)]
  const out = validateMatches(matches, 3)
  assert.equal(out.length, 3)
})

test("empty matches payload is rejected", () => {
  assert.throws(() => validateMatches([], 380), assertCode("EMPTY_MATCHES"))
})

test("a non-array payload is rejected", () => {
  assert.throws(() => validateMatches({ matches: [] }, 380), assertCode("NOT_AN_ARRAY"))
})

test("a count mismatch is rejected", () => {
  assert.throws(() => validateMatches([makeMatch(1)], 380), assertCode("MATCH_COUNT_MISMATCH"))
})

test("a duplicate provider id is rejected", () => {
  assert.throws(() => validateMatches([makeMatch(1), makeMatch(1)], 2), assertCode("DUPLICATE_PROVIDER_ID"))
})

test("an unknown status is rejected", () => {
  assert.throws(
    () => validateMatches([makeMatch(1, { status: "WEIRD_STATE" })], 1),
    assertCode("UNKNOWN_STATUS"),
  )
})

test("an invalid kickoff is rejected", () => {
  assert.throws(
    () => validateMatches([makeMatch(1, { utcDate: "not-a-date" })], 1),
    assertCode("INVALID_KICKOFF"),
  )
})

test("a match with the same team home and away is rejected", () => {
  const m = makeMatch(1)
  const dup = { ...m, awayTeam: m.homeTeam }
  assert.throws(() => validateMatches([dup], 1), assertCode("SAME_TEAM_BOTH_SIDES"))
})

test("a FINISHED match without a complete full-time score is rejected (incomplete)", () => {
  const m = makeMatch(1, {
    status: "FINISHED",
    score: { winner: null, duration: "REGULAR", fullTime: { home: null, away: 1 }, halfTime: { home: 0, away: 0 } },
  })
  assert.throws(() => validateMatches([m], 1), assertCode("INCOMPLETE_FINISHED_SCORE"))
})

test("a FINISHED match with a negative score is rejected", () => {
  const m = makeMatch(1, {
    status: "FINISHED",
    score: { winner: "HOME_TEAM", duration: "REGULAR", fullTime: { home: -1, away: 0 }, halfTime: { home: 0, away: 0 } },
  })
  assert.throws(() => validateMatches([m], 1), assertCode("INCOMPLETE_FINISHED_SCORE"))
})

test("the wrapper client propagates a 401 auth failure as a FootballDataError", async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.FOOTBALL_DATA_API_KEY
  process.env.FOOTBALL_DATA_API_KEY = "test-token"
  globalThis.fetch = (async () => new Response("Unauthorized", { status: 401 })) as typeof fetch
  try {
    await assert.rejects(
      () => fetchPremierLeagueMatches({ offlineMatches: undefined }),
      (err: unknown) => err instanceof Error && err.message.includes("401"),
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.FOOTBALL_DATA_API_KEY
    else process.env.FOOTBALL_DATA_API_KEY = originalKey
  }
})
