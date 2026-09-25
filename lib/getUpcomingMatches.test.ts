import { test } from "node:test"
import assert from "node:assert/strict"
import { getSyncedDataAsOf, loadSyncedMatches } from "@/lib/synced-data"
import { getUpcomingMatches, getRecentFinishedMatches } from "@/lib/getUpcomingMatches"
import { getCountdown, isMatchLive } from "@/lib/getCountdown"
import { sortMatchesByKickoff, findNextMatch, uniqueMatchDates } from "@/lib/sortMatches"

/**
 * Determinism contract for the World Cup 2026 time-sensitive helpers.
 *
 * The archive is fully finished: every synced match carries status "finished"
 * and the same `sourceUpdatedAt`. These tests pin that (a) no helper reads the
 * wall clock — the reference time is always injected or derived from the
 * snapshot — and (b) the same reference time yields the same classification, so
 * a static build is byte-reproducible and the server/client first screens agree.
 */

const AS_OF = "2026-08-02T20:20:11Z"

test("getSyncedDataAsOf is derived from the snapshot, not the clock", () => {
  assert.equal(getSyncedDataAsOf(), AS_OF)
})

test("getSyncedDataAsOf is stable across calls", () => {
  assert.equal(getSyncedDataAsOf(), getSyncedDataAsOf())
})

test("every synced match is finished, so upcoming is empty at archive as-of", () => {
  const synced = loadSyncedMatches()
  assert.ok(synced.length >= 72, `expected >= 72 synced matches, got ${synced.length}`)
  for (const m of synced) assert.equal(m.status, "finished")
  assert.deepEqual(getUpcomingMatches(AS_OF), [])
})

test("getUpcomingMatches is deterministic for the same reference time", () => {
  assert.deepEqual(getUpcomingMatches(AS_OF), getUpcomingMatches(AS_OF))
})

test("getRecentFinishedMatches returns finished matches, newest kickoff first", () => {
  const recent = getRecentFinishedMatches(10)
  assert.equal(recent.length, 10)
  for (const m of recent) assert.equal(m.syncedStatus, "finished")
  for (let i = 1; i < recent.length; i++) {
    const a = new Date(recent[i - 1].utcDate ?? recent[i - 1].date).getTime()
    const b = new Date(recent[i].utcDate ?? recent[i].date).getTime()
    assert.ok(a >= b, "results must be ordered newest-first")
  }
})

test("getCountdown is deterministic for a fixed reference", () => {
  const target = "2026-09-01T00:00:00Z"
  assert.equal(getCountdown(target, AS_OF), getCountdown(target, AS_OF))
  // reference after target → "Starting soon"
  assert.equal(getCountdown(target, "2026-09-02T00:00:00Z"), "Starting soon")
})

test("isMatchLive takes an explicit reference, no clock", () => {
  const target = "2026-08-02T20:00:00Z"
  assert.equal(isMatchLive(target, "2026-08-02T20:30:00Z"), true)
  assert.equal(isMatchLive(target, "2026-08-02T23:00:00Z"), false)
})

test("findNextMatch uses the injected reference", () => {
  const items = [
    { date: "2026-06-01", utcDate: "2026-06-01T10:00:00Z" },
    { date: "2026-06-02", utcDate: "2026-06-02T10:00:00Z" },
  ]
  assert.equal(findNextMatch(items, "2026-06-01T12:00:00Z")?.date, "2026-06-02")
  assert.equal(findNextMatch(items, "2026-06-03T00:00:00Z"), undefined)
})

test("sortMatchesByKickoff and uniqueMatchDates are pure", () => {
  const a = { date: "2026-06-02" }
  const b = { date: "2026-06-01" }
  assert.deepEqual(sortMatchesByKickoff([a, b]).map((x) => x.date), ["2026-06-01", "2026-06-02"])
  assert.deepEqual(
    uniqueMatchDates([{ date: "2026-06-02" }, { date: "2026-06-01" }, { date: "2026-06-02" }]),
    ["2026-06-01", "2026-06-02"],
  )
})
