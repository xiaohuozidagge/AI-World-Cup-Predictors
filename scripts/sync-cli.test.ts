/**
 * Subprocess integration tests for the sync CLI.
 *
 * Each case builds a minimal static snapshot in a temp directory, writes an
 * offline `--source-file` payload, and spawns the real CLI (`node` → `tsx` →
 * the sync script) with `cwd` pointed at that snapshot. This pins the
 * process-level contract the earlier dry-run broke:
 *
 *   - a dry-run is a true zero-write operation (no report/tmp/backup/lock file),
 *   - `--report-file` writes only the named file and rejects escape/root paths,
 *   - the process exits naturally (never a forced `process.exit()`), so it never
 *     hits the Windows libuv `UV_HANDLE_CLOSING` assertion, and
 *   - the token never appears on stdout/stderr.
 *
 * No network, no real token: every case runs offline.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const TSX_CLI = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs")
const SCRIPT = join(process.cwd(), "scripts", "sync-premier-league-fixtures.ts")

const PL_ID = "cb5d6d33-9375-49f5-8cbd-d59754222a97"

// --- factories ---------------------------------------------------------------

function competition() {
  return {
    id: PL_ID,
    provider: "football-data",
    provider_competition_id: 2021,
    slug: "premier-league",
    name: "Premier League",
    short_name: "EPL",
    country: "England",
    competition_type: "LEAGUE",
    current_season: 2026,
    logo_url: null,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }
}

function team(providerTeamId: number, slug: string) {
  return {
    id: `team-${providerTeamId}`,
    provider: "football-data",
    provider_team_id: providerTeamId,
    name: `Team ${providerTeamId}`,
    short_name: slug.toUpperCase(),
    slug,
    country: "England",
    logo_url: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }
}

function fixture(providerFixtureId: number, status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `fx-${providerFixtureId}`,
    provider: "football-data",
    provider_fixture_id: providerFixtureId,
    competition_id: PL_ID,
    season: 2026,
    round: null,
    matchweek: 1,
    stage: "REGULAR_SEASON",
    home_team_id: "team-1",
    away_team_id: "team-2",
    kickoff_at: "2026-08-21T19:00:00Z",
    venue_name: null,
    venue_city: null,
    status,
    elapsed_minutes: null,
    home_score: null,
    away_score: null,
    halftime_home_score: null,
    halftime_away_score: null,
    fulltime_home_score: null,
    fulltime_away_score: null,
    winner_team_id: null,
    source_updated_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function finishedFixture(providerFixtureId: number, home: number, away: number) {
  return fixture(providerFixtureId, "FINISHED", {
    fulltime_home_score: home,
    fulltime_away_score: away,
    home_score: home,
    away_score: away,
    winner_team_id: home > away ? "team-1" : home < away ? "team-2" : null,
  })
}

function manifest(fixtureCount: number, finishedCount: number) {
  return {
    schemaVersion: 1,
    provider: "football-data",
    exportedAt: "2026-01-01T00:00:00Z",
    sourceLastUpdatedAt: null,
    counts: {
      competitions: 1,
      teams: 2,
      fixtures: fixtureCount,
      finishedFixtures: finishedCount,
      scheduledFixtures: fixtureCount - finishedCount,
    },
    competitions: [
      {
        slug: "premier-league",
        season: 2026,
        teams: 2,
        fixtures: fixtureCount,
        finishedFixtures: finishedCount,
        upcomingFixtures: fixtureCount - finishedCount,
      },
    ],
  }
}

function match(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    utcDate: "2026-08-21T19:00:00Z",
    status: "SCHEDULED",
    matchday: 1,
    stage: "REGULAR_SEASON",
    group: null,
    lastUpdated: "2026-09-18T00:20:33Z",
    homeTeam: { id: 1, name: "Team 1", shortName: null, tla: null, crest: null },
    awayTeam: { id: 2, name: "Team 2", shortName: null, tla: null, crest: null },
    score: { winner: null, duration: "REGULAR", fullTime: { home: null, away: null }, halfTime: { home: null, away: null } },
    ...overrides,
  }
}

function finishedMatch(id: number, home: number, away: number, winner: "HOME_TEAM" | "AWAY_TEAM" | "DRAW") {
  return match(id, {
    status: "FINISHED",
    score: { winner, duration: "REGULAR", fullTime: { home, away }, halfTime: { home: 0, away: 0 } },
    lastUpdated: "2026-09-21T00:00:00Z",
  })
}

// --- snapshot / run helpers --------------------------------------------------

function makeSnapshotDir(fixtures: object[], finishedCount: number): string {
  const root = mkdtempSync(join(tmpdir(), "sync-cli-"))
  const dir = join(root, "data", "football")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "competitions.json"), JSON.stringify([competition()], null, 2))
  writeFileSync(join(dir, "teams.json"), JSON.stringify([team(1, "team-one"), team(2, "team-two")], null, 2))
  writeFileSync(join(dir, "fixtures.json"), JSON.stringify(fixtures, null, 2))
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest(fixtures.length, finishedCount), null, 2))
  return root
}

function writeSource(matches: object[]): string {
  const p = join(tmpdir(), `sync-cli-source-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(p, JSON.stringify(matches, null, 2))
  return p
}

/** Byte fingerprint of the four tracked data files the sync may touch. */
function dataFingerprint(root: string): string {
  const dir = join(root, "data", "football")
  return [
    "competitions.json",
    "teams.json",
    "fixtures.json",
    "manifest.json",
  ]
    .map((f) => readFileSync(join(dir, f)).toString("hex"))
    .join(":")
}

function residueFiles(root: string): string[] {
  const out: string[] = []
  const walk = (d: string, prefix: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const rel = prefix ? `${prefix}/${e}` : e
      if (statSync(p).isDirectory()) walk(p, rel)
      else if (rel.includes("sync-diff-report") || rel.includes(".sync-transaction") || e.endsWith(".tmp")) {
        out.push(rel)
      }
    }
  }
  walk(root, "")
  return out.sort()
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function runCli(args: string[], cwd: string, env: Record<string, string> = {}): RunResult {
  const res = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...env },
  })
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
}

// --- tests -------------------------------------------------------------------

test("offline dry-run with no changes exits 0 and writes nothing", () => {
  const root = makeSnapshotDir([fixture(1, "SCHEDULED")], 0)
  const source = writeSource([match(1)])
  const before = dataFingerprint(root)

  const res = runCli(["--source-file", source], root)

  assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`)
  assert.equal(dataFingerprint(root), before, "data/football must be byte-identical")
  assert.deepEqual(residueFiles(root), [], "no report/tmp/backup/lock residue")
})

test("offline dry-run with a TIMED -> FINISHED change exits 0 and writes nothing", () => {
  const root = makeSnapshotDir([fixture(1, "TIMED")], 0)
  const source = writeSource([finishedMatch(1, 2, 1, "HOME_TEAM")])
  const before = dataFingerprint(root)

  const res = runCli(["--source-file", source], root)

  assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`)
  assert.ok(res.stdout.includes("Newly finished:"), "diff should report the newly finished match")
  assert.ok(/Safe to apply:\s+yes/.test(res.stdout), "safeToApply should be yes")
  assert.equal(dataFingerprint(root), before, "data/football must be byte-identical")
  assert.deepEqual(residueFiles(root), [], "no report/tmp/backup/lock residue")
})

test("default dry-run leaves no report/tmp/backup/lock residue", () => {
  const root = makeSnapshotDir([fixture(1, "TIMED")], 0)
  const source = writeSource([finishedMatch(1, 2, 1, "HOME_TEAM")])

  const res = runCli(["--source-file", source], root)

  assert.equal(res.status, 0)
  assert.equal(existsSync(join(root, "sync-diff-report.json")), false, "no sync-diff-report.json in the tree")
  assert.deepEqual(residueFiles(root), [], "no .sync-transaction tmp/backup/lock or .tmp residue")
})

test("--report-file writes only the named file", () => {
  const root = makeSnapshotDir([fixture(1, "TIMED")], 0)
  const source = writeSource([finishedMatch(1, 2, 1, "HOME_TEAM")])
  const reportPath = join(tmpdir(), `sync-cli-report-${Math.random().toString(36).slice(2)}.json`)
  const before = dataFingerprint(root)

  const res = runCli(["--source-file", source, "--report-file", reportPath], root)

  assert.equal(res.status, 0)
  assert.equal(existsSync(reportPath), true, "the named report file must be written")
  const report = JSON.parse(readFileSync(reportPath, "utf8"))
  assert.equal(report.dataChanged, true)
  assert.equal(report.safeToApply, true)
  assert.equal(dataFingerprint(root), before, "data/football must be byte-identical")
  assert.deepEqual(residueFiles(root), [], "nothing written inside the snapshot")
})

test("--report-file rejects a path that escapes the working directory", () => {
  const root = makeSnapshotDir([fixture(1, "SCHEDULED")], 0)
  const source = writeSource([match(1)])

  const res = runCli(["--source-file", source, "--report-file", "../evil.json"], root)

  assert.equal(res.status, 2)
  assert.ok(res.stderr.includes("must not escape"), res.stderr)
})

test("--report-file rejects the repo root as an illegal location", () => {
  const root = makeSnapshotDir([fixture(1, "SCHEDULED")], 0)
  const source = writeSource([match(1)])

  const res = runCli(["--source-file", source, "--report-file", "sync-diff-report.json"], root)

  assert.equal(res.status, 2)
  assert.ok(res.stderr.includes("repo root"), res.stderr)
  assert.equal(existsSync(join(root, "sync-diff-report.json")), false)
})

test("safeToApply=false (score correction) exits cleanly with an explicit result", () => {
  const root = makeSnapshotDir([finishedFixture(1, 2, 1)], 1)
  const source = writeSource([finishedMatch(1, 3, 1, "HOME_TEAM")])

  const res = runCli(["--source-file", source], root)

  assert.notEqual(res.status, 127, "must not hit the Windows libuv assertion")
  assert.equal(res.status, 0, `dry-run with a correction is still ok=true; got ${res.status}`)
  assert.ok(/Safe to apply:\s+no/.test(res.stdout))
  assert.ok(res.stdout.includes("SCORE CORRECTIONS REQUIRED"))
  assert.ok(!res.stderr.includes("Assertion failed"), "no native assertion in stderr")
})

test("a sync-engine hard failure exits non-zero without a native assertion", () => {
  // A winner inconsistent with the score passes shape validation but fails the sync.
  const root = makeSnapshotDir([fixture(1, "TIMED")], 0)
  const source = writeSource([finishedMatch(1, 2, 1, "AWAY_TEAM")])

  const res = runCli(["--source-file", source], root)

  assert.equal(res.status, 1, `expected exit 1 for a hard failure, got ${res.status}`)
  assert.ok(res.stdout.includes("WINNER_SCORE_MISMATCH"))
  assert.ok(!res.stderr.includes("Assertion failed"), "no native assertion")
})

test("stdout/stderr never contain the token", () => {
  const root = makeSnapshotDir([fixture(1, "SCHEDULED")], 0)
  const source = writeSource([match(1)])
  const SENTINEL = "SENTINEL_TOKEN_abc123"

  const res = runCli(["--source-file", source], root, { FOOTBALL_DATA_API_KEY: SENTINEL })

  assert.ok(!res.stdout.includes(SENTINEL), "token must not appear in stdout")
  assert.ok(!res.stderr.includes(SENTINEL), "token must not appear in stderr")
})
