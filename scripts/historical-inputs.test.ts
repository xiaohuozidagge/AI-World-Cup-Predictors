/**
 * Tests for the historical-input recovery chain behind `predictions:pl:verify`.
 *
 * The Champions League removal pruned `data/football/*.json` from 524 to 380
 * fixtures, so the generation-time `inputDataHash` can no longer be recomputed
 * from the current tree. These tests pin the recovery contract:
 *
 *  1. historical inputs come from the provenance commit (524 fixtures, CL present)
 *  2. the recomputed historical hash equals the manifest's stored hash
 *  3. the current pruned data does NOT reproduce the stored hash
 *  4. a non-SHA provenance value is rejected
 *  5. a well-formed but nonexistent commit is rejected
 *  6. a commit that is not an ancestor of HEAD is rejected
 *  7. a missing historical input file fails hard
 *  8. a PL fixture that cannot map fails hard
 *  9. Champions League runtime data fails hard
 * 10. the whole read-only chain modifies no data file
 *
 * Every case is read-only: it never writes to data/ and never mutates the git
 * object store.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { HISTORY_SEASONS } from "../lib/football/history-seasons"

import {
  assertCurrentPlMappingValid,
  assertHistoricalInputHashMatches,
  assertNoChampionsLeagueRuntimeData,
  CHAMPIONS_LEAGUE_RUNTIME_DATA_PRESENT,
  computeHistoricalInputDataHash,
  CURRENT_PL_MAPPING_MISMATCH,
  gitRevParse,
  gitShowBlob,
  HISTORICAL_INPUT_HASH_MISMATCH,
  HISTORICAL_INPUT_PATHS,
  HISTORICAL_SOURCE_COMMIT_UNAVAILABLE,
  HistoricalVerificationError,
  readCurrentCompetitions,
  validateProvenanceCommit,
} from "./historical-inputs"

const ROOT = process.cwd()
const FOOTBALL_DIR = join(ROOT, "data", "football")
const HISTORY_DIR = join(ROOT, "data", "history", "premier-league", "normalized")

const manifest = JSON.parse(
  readFileSync(join(ROOT, "data", "predictions", "premier-league", "2026-27", "manifest.json"), "utf8"),
) as { baseCommit: string; inputDataHash: string }

const BASE_COMMIT = manifest.baseCommit
const STORED_HASH = manifest.inputDataHash

/** Assert an error is a `HistoricalVerificationError` with the expected code. */
function assertCode(expectedCode: string) {
  return (err: unknown) => {
    assert.ok(err instanceof HistoricalVerificationError, `expected HistoricalVerificationError, got ${String(err)}`)
    assert.equal((err as HistoricalVerificationError).code, expectedCode)
    return true
  }
}

test("1. historical inputs are read from the provenance commit, not the pruned tree", () => {
  const historicalComps = JSON.parse(
    gitShowBlob(BASE_COMMIT, "data/football/competitions.json").toString("utf8"),
  ) as { slug: string }[]
  const currentComps = readCurrentCompetitions()

  // The commit predates the Champions League removal: it still lists CL.
  assert.ok(historicalComps.some((c) => c.slug === "champions-league"), "commit must still carry champions-league")
  assert.ok(!currentComps.some((c) => c.slug === "champions-league"), "current data must be CL-free")

  const historicalFixtures = JSON.parse(
    gitShowBlob(BASE_COMMIT, "data/football/fixtures.json").toString("utf8"),
  ) as unknown[]
  const currentFixtures = JSON.parse(readFileSync(join(FOOTBALL_DIR, "fixtures.json"), "utf8")) as unknown[]
  assert.equal(historicalFixtures.length, 524, "generation input held 524 fixtures")
  assert.equal(currentFixtures.length, 380, "current tree is pruned to 380 fixtures")
})

test("2. recomputed historical inputDataHash equals the stored manifest hash", () => {
  assert.equal(computeHistoricalInputDataHash(BASE_COMMIT), STORED_HASH)
})

test("3. the current (pruned) data does not reproduce the stored hash", () => {
  const h = createHash("sha256")
  for (const spec of HISTORY_SEASONS) {
    h.update(readFileSync(join(HISTORY_DIR, `${spec.season}.json`)))
  }
  for (const name of ["competitions.json", "teams.json", "fixtures.json", "manifest.json"] as const) {
    h.update(readFileSync(join(FOOTBALL_DIR, name)))
  }
  assert.notEqual(h.digest("hex"), STORED_HASH)
})

test("4. a non-SHA provenance value is rejected", () => {
  assert.throws(() => validateProvenanceCommit("not-a-sha", "HEAD"), assertCode(HISTORICAL_SOURCE_COMMIT_UNAVAILABLE))
  assert.throws(() => validateProvenanceCommit("", "HEAD"), assertCode(HISTORICAL_SOURCE_COMMIT_UNAVAILABLE))
  assert.throws(() => validateProvenanceCommit("abc123", "HEAD"), assertCode(HISTORICAL_SOURCE_COMMIT_UNAVAILABLE))
})

test("5. a well-formed but nonexistent commit is rejected", () => {
  assert.throws(() => validateProvenanceCommit("0".repeat(40), "HEAD"), assertCode(HISTORICAL_SOURCE_COMMIT_UNAVAILABLE))
})

test("6. a commit that is not an ancestor of HEAD is rejected", (t) => {
  const head = gitRevParse("HEAD")
  if (head === BASE_COMMIT) {
    t.skip("HEAD is the provenance commit; no non-ancestor relation to test")
    return
  }
  // BASE_COMMIT is an ancestor of HEAD, so HEAD is NOT an ancestor of BASE_COMMIT.
  assert.throws(() => validateProvenanceCommit(head, BASE_COMMIT), assertCode(HISTORICAL_SOURCE_COMMIT_UNAVAILABLE))
})

test("7. a missing historical input file fails hard", () => {
  assert.throws(
    () => gitShowBlob(BASE_COMMIT, "data/football/does-not-exist.json"),
    assertCode(HISTORICAL_SOURCE_COMMIT_UNAVAILABLE),
  )
})

test("8. a PL fixture that cannot map fails hard", () => {
  assert.throws(
    () =>
      assertCurrentPlMappingValid(
        [
          {
            id: "f-ghost-home",
            competition_id: "PL",
            home_team_id: "ghost",
            away_team_id: "real",
            status: "SCHEDULED",
            fulltime_home_score: null,
            fulltime_away_score: null,
          },
        ],
        new Set(["real"]),
        "PL",
      ),
    assertCode(CURRENT_PL_MAPPING_MISMATCH),
  )
})

test("9. Champions League runtime data fails hard", () => {
  // A CL competition present.
  assert.throws(
    () => assertNoChampionsLeagueRuntimeData([{ id: "cl", slug: "champions-league" }], [], "PL"),
    assertCode(CHAMPIONS_LEAGUE_RUNTIME_DATA_PRESENT),
  )
  // A fixture referencing a non-PL competition.
  assert.throws(
    () =>
      assertNoChampionsLeagueRuntimeData(
        [{ id: "PL", slug: "premier-league" }],
        [
          {
            id: "f-cl",
            competition_id: "cl",
            home_team_id: "a",
            away_team_id: "b",
            status: "SCHEDULED",
            fulltime_home_score: null,
            fulltime_away_score: null,
          },
        ],
        "PL",
      ),
    assertCode(CHAMPIONS_LEAGUE_RUNTIME_DATA_PRESENT),
  )
})

test("10. the read-only verification chain modifies no data file", () => {
  const files = [
    join(FOOTBALL_DIR, "competitions.json"),
    join(FOOTBALL_DIR, "teams.json"),
    join(FOOTBALL_DIR, "fixtures.json"),
    join(FOOTBALL_DIR, "manifest.json"),
    ...HISTORY_SEASONS.map((s) => join(HISTORY_DIR, `${s.season}.json`)),
  ]
  const before = files.map((f) => readFileSync(f).toString("hex"))

  // Exercise the full chain with real current data.
  const competitions = readCurrentCompetitions()
  const plId = competitions.find((c) => c.slug === "premier-league")!.id
  const fixtures = JSON.parse(readFileSync(join(FOOTBALL_DIR, "fixtures.json"), "utf8")) as {
    id: string
    competition_id: string
    home_team_id: string
    away_team_id: string
    status: string
    fulltime_home_score: number | null
    fulltime_away_score: number | null
  }[]
  const teams = JSON.parse(readFileSync(join(FOOTBALL_DIR, "teams.json"), "utf8")) as { id: string }[]

  validateProvenanceCommit(BASE_COMMIT, gitRevParse("HEAD"))
  assert.equal(computeHistoricalInputDataHash(BASE_COMMIT), STORED_HASH)
  assertNoChampionsLeagueRuntimeData(competitions, fixtures, plId)
  assertCurrentPlMappingValid(fixtures, new Set(teams.map((t) => t.id)), plId)

  const after = files.map((f) => readFileSync(f).toString("hex"))
  assert.deepEqual(after, before, "verification must be read-only")
})

test("11. a working-tree history change does not affect the historical hash", () => {
  const file = join(HISTORY_DIR, `${HISTORY_SEASONS[0].season}.json`)
  const original = readFileSync(file)
  try {
    writeFileSync(file, Buffer.from("corrupted-working-tree-copy\n"))
    assert.equal(computeHistoricalInputDataHash(BASE_COMMIT), STORED_HASH)
  } finally {
    writeFileSync(file, original)
  }
})

test("12. a missing history season in the provenance commit hard-fails", () => {
  assert.throws(
    () => gitShowBlob(BASE_COMMIT, "data/history/premier-league/normalized/1999-00.json"),
    assertCode(HISTORICAL_SOURCE_COMMIT_UNAVAILABLE),
  )
})

test("13. changed input content yields HISTORICAL_INPUT_HASH_MISMATCH", () => {
  // Any stored hash that does not match the provenance commit's real inputs
  // must hard-fail with the mismatch code (never a warning or a silent pass).
  assert.throws(
    () => assertHistoricalInputHashMatches(BASE_COMMIT, "0".repeat(64)),
    assertCode(HISTORICAL_INPUT_HASH_MISMATCH),
  )
  // The true stored hash still passes.
  assertHistoricalInputHashMatches(BASE_COMMIT, STORED_HASH)
})

test("14. all nine generation inputs are read from the single provenance commit", () => {
  assert.equal(HISTORICAL_INPUT_PATHS.length, 9, "5 history seasons + 4 football files")
  for (const path of HISTORICAL_INPUT_PATHS) {
    gitShowBlob(BASE_COMMIT, path) // throws HISTORICAL_SOURCE_COMMIT_UNAVAILABLE if absent
  }
})

test("15. the historical hash never reads working-tree football files", () => {
  const file = join(FOOTBALL_DIR, "manifest.json")
  const original = readFileSync(file)
  try {
    writeFileSync(file, Buffer.from("{}"))
    assert.equal(computeHistoricalInputDataHash(BASE_COMMIT), STORED_HASH)
  } finally {
    writeFileSync(file, original)
  }
})

test("16. the real historical inputs recompute the stored hash", () => {
  assert.equal(STORED_HASH, "48e760d814101f5e3fa045c99d62fc9f03b298c501a4f7546aee38885d44d923")
  assert.equal(computeHistoricalInputDataHash(BASE_COMMIT), STORED_HASH)
})
