import { test } from "node:test"
import assert from "node:assert/strict"

import manifestJson from "@/data/football/manifest.json"
import type { StaticManifest } from "./static-types"
import {
  partitionFixtures,
  STATIC_DATA_AS_OF,
  STATIC_NOW,
  type DirectoryFixtureLike,
} from "./match-logic"
import type { FixtureStatus } from "@/lib/supabase/types"

function fx(status: FixtureStatus, kickoffAt: string): DirectoryFixtureLike {
  return { status, kickoffAt, matchweek: null, stage: null }
}

const manifest = manifestJson as unknown as StaticManifest

// (1) no 1970 sentinel ---------------------------------------------------------

test("STATIC_NOW is no longer a 1970 sentinel and aliases STATIC_DATA_AS_OF", () => {
  assert.notEqual(STATIC_NOW, "1970-01-01T00:00:00Z")
  assert.equal(STATIC_NOW, STATIC_DATA_AS_OF)
  assert.equal(new Date(STATIC_NOW).getFullYear(), 2026)
})

// (2) STATIC_DATA_AS_OF equals the manifest's real snapshot time ---------------

test("STATIC_DATA_AS_OF equals the manifest snapshot time", () => {
  assert.equal(STATIC_DATA_AS_OF, manifest.sourceLastUpdatedAt ?? manifest.exportedAt)
})

// (3) FINISHED → Results --------------------------------------------------------

test("FINISHED fixtures always go to results", () => {
  const p = partitionFixtures([fx("FINISHED", "2026-08-01T15:00:00Z")])
  assert.equal(p.results.length, 1)
  assert.equal(p.inProgress.length + p.upcoming.length + p.other.length, 0)
})

// (4) LIVE / HALFTIME → In Progress --------------------------------------------

test("LIVE and HALFTIME fixtures go to in-progress", () => {
  const p = partitionFixtures([fx("LIVE", "2026-08-10T12:00:00Z"), fx("HALFTIME", "2026-08-10T12:00:00Z")])
  assert.equal(p.inProgress.length, 2)
  assert.equal(p.results.length + p.upcoming.length + p.other.length, 0)
})

// (5) TIMED / SCHEDULED → Upcoming (regardless of kickoff date) ----------------

test("TIMED and SCHEDULED fixtures go to upcoming regardless of kickoff date", () => {
  const p = partitionFixtures([fx("TIMED", "2026-09-01T15:00:00Z"), fx("SCHEDULED", "2020-01-01T15:00:00Z")])
  assert.equal(p.upcoming.length, 2)
  assert.equal(p.results.length + p.inProgress.length + p.other.length, 0)
})

// (6) POSTPONED / SUSPENDED / CANCELLED → other --------------------------------

test("POSTPONED / SUSPENDED / CANCELLED fixtures go to other, never upcoming or results", () => {
  const p = partitionFixtures([
    fx("POSTPONED", "2026-08-25T15:00:00Z"),
    fx("SUSPENDED", "2026-08-25T15:00:00Z"),
    fx("CANCELLED", "2026-08-25T15:00:00Z"),
  ])
  assert.equal(p.other.length, 3)
  assert.equal(p.results.length + p.upcoming.length + p.inProgress.length, 0)
})

// (7) determinism --------------------------------------------------------------

test("partitionFixtures is deterministic and sorts within buckets", () => {
  const fixtures = [
    fx("FINISHED", "2026-08-01T15:00:00Z"),
    fx("TIMED", "2026-09-02T15:00:00Z"),
    fx("TIMED", "2026-09-01T15:00:00Z"),
    fx("LIVE", "2026-08-10T12:00:00Z"),
    fx("CANCELLED", "2026-08-25T15:00:00Z"),
  ]
  const a = partitionFixtures(fixtures)
  const b = partitionFixtures(fixtures)
  assert.deepEqual(a, b)
  assert.deepEqual(
    a.upcoming.map((f) => f.kickoffAt),
    ["2026-09-01T15:00:00Z", "2026-09-02T15:00:00Z"],
  )
})
