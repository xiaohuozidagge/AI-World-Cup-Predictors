#!/usr/bin/env tsx
/**
 * Premier League in-season fixture sync CLI.
 *
 *   npm run football:pl:sync:dry-run                          — live dry-run (no write)
 *   npm run football:pl:sync:dry-run -- --source-file=<path>  — offline dry-run
 *   npm run football:pl:sync -- --apply                       — live apply (explicit)
 *   npm run football:pl:sync -- --apply --source-file=<path>  — offline apply
 *
 * The token is read only from `FOOTBALL_DATA_API_KEY` (via the existing client,
 * optionally seeded from `.env.sync` by `loadSyncEnv`). It is never logged.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { loadSyncEnv } from "./load-sync-env"
loadSyncEnv()

import { fetchPremierLeagueMatches } from "../lib/football/football-data-client"
import {
  applySnapshot,
  buildProposedManifest,
  computeSyncDiff,
  formatChangeReport,
  formatDiffReport,
  loadLocalSnapshot,
  type SyncDiff,
} from "../lib/football/fixture-sync"

const SYNC_DIFF_REPORT_REL = "sync-diff-report.json"

interface SyncDiffReport {
  schemaVersion: 1
  apply: boolean
  dataChanged: boolean
  inputHash: string
  outputHash: string
  sourceLastUpdatedAt: string | null
  changeCount: number
  ok: boolean
  safeToApply: boolean
}

/**
 * Persist a machine-readable diff report for the artifact pipeline. Written for
 * both dry-run and apply so the downstream `artifact-manifest.json` can decide
 * whether a data change actually occurred. Transient — never committed.
 */
function writeSyncDiffReport(diff: SyncDiff, apply: boolean, root: string): void {
  const report: SyncDiffReport = {
    schemaVersion: 1,
    apply,
    dataChanged: diff.changes.length > 0,
    inputHash: diff.inputHash,
    outputHash: diff.outputHash,
    sourceLastUpdatedAt: diff.sourceLastUpdatedAt,
    changeCount: diff.changes.length,
    ok: diff.ok,
    safeToApply: diff.safeToApply,
  }
  writeFileSync(join(root, SYNC_DIFF_REPORT_REL), `${JSON.stringify(report, null, 2)}\n`, "utf8")
}

interface CliArgs {
  apply: boolean
  sourceFile: string | null
}

function parseArgs(argv: string[]): CliArgs {
  let apply = false
  let sourceFile: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--apply") apply = true
    else if (a === "--source-file") {
      if (i + 1 < argv.length) sourceFile = argv[++i]
    } else if (a.startsWith("--source-file=")) {
      sourceFile = a.slice("--source-file=".length)
    }
  }
  return { apply, sourceFile }
}

function loadOfflineMatches(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    console.error(`ERROR: cannot read --source-file ${path}`)
    process.exit(2)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    console.error(`ERROR: --source-file ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
  if (Array.isArray(parsed)) return parsed
  if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { matches?: unknown }).matches)) {
    return (parsed as { matches: unknown[] }).matches
  }
  console.error(`ERROR: --source-file ${path} must be an array or { matches: [...] }`)
  process.exit(2)
}

/** Fingerprint the two target files so dry-run can prove it never touched them. */
function dataFileFingerprint(root: string): string {
  const dir = join(root, "data", "football")
  const fixtures = readFileSync(join(dir, "fixtures.json")).toString("hex")
  const manifest = readFileSync(join(dir, "manifest.json")).toString("hex")
  return `${fixtures}:${manifest}`
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const root = process.cwd()

  const offline = args.sourceFile !== null ? loadOfflineMatches(args.sourceFile) : undefined

  let matches
  try {
    matches = await fetchPremierLeagueMatches({ offlineMatches: offline })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (offline === undefined && /FOOTBALL_DATA_API_KEY|not configured/i.test(msg)) {
      console.error(`LIVE_DRY_RUN_NOT_EXECUTED: ${msg}`)
      console.error(`Provide a --source-file=<path> fixture for an offline run, or set FOOTBALL_DATA_API_KEY.`)
      process.exit(0)
    }
    console.error(`ERROR: ${msg}`)
    process.exit(2)
  }

  const before = dataFileFingerprint(root)
  const snapshot = loadLocalSnapshot(root)
  const appliedAt = args.apply ? new Date().toISOString() : null
  const diff = computeSyncDiff(matches, snapshot, appliedAt)

  writeSyncDiffReport(diff, args.apply, root)

  console.log(formatDiffReport(diff))
  console.log()
  if (diff.hardFailures.length > 0) {
    console.log(`HARD FAILURES (${diff.hardFailures.length}):`)
    for (const f of diff.hardFailures) console.log(`  [${f.code}] ${f.message}`)
  }
  if (diff.corrections.length > 0) {
    console.log(`SCORE CORRECTIONS REQUIRED (${diff.corrections.length}):`)
    for (const c of diff.corrections) console.log(`  [${c.code}] ${c.message}`)
  }
  if (diff.changes.length > 0) {
    console.log(`Per-match changes (${diff.changes.length}):`)
    console.log(formatChangeReport(diff.changes))
  }

  const after = dataFileFingerprint(root)
  if (before !== after) {
    console.error("ERROR: sync modified data/football/*.json before --apply (should never happen)")
    process.exit(1)
  }

  if (!args.apply) {
    if (diff.changes.length === 0 && diff.hardFailures.length === 0) {
      console.log(`\nNo data change — nothing to apply.`)
    } else {
      console.log(`\nDry-run only. Re-run with --apply to write.`)
    }
    process.exit(diff.ok ? 0 : 1)
  }

  // --- apply path ---
  if (!diff.ok) {
    console.error("\nRefusing to apply: identity/validation failures present.")
    process.exit(1)
  }
  if (!diff.safeToApply) {
    console.error("\nRefusing to apply: FINISHED score correction(s) need manual confirmation.")
    process.exit(1)
  }
  if (diff.changes.length === 0) {
    console.log("\nNo semantic change — nothing to write, no timestamp churn, no commit/build/deploy.")
    process.exit(0)
  }

  const exportedAt = appliedAt ?? new Date().toISOString()
  const proposedManifest = buildProposedManifest({
    snapshot,
    fixtures: diff.proposedFixtures,
    sourceLastUpdatedAt: diff.sourceLastUpdatedAt,
    exportedAt,
  })

  applySnapshot(diff.proposedFixtures, proposedManifest, root)

  const reapplied = loadLocalSnapshot(root)
  const finished = reapplied.fixtures.filter((f) => f.status === "FINISHED")
  const badFinished = finished.filter(
    (f) =>
      !Number.isInteger(f.fulltime_home_score) ||
      !Number.isInteger(f.fulltime_away_score) ||
      (f.fulltime_home_score as number) < 0 ||
      (f.fulltime_away_score as number) < 0,
  )
  if (badFinished.length > 0 || reapplied.manifest.counts.finishedFixtures !== finished.length) {
    console.error("ERROR: post-apply verification failed — manifest counts vs finished fixtures disagree.")
    process.exit(1)
  }

  console.log(`\nApplied ${diff.changes.length} fixture change(s) atomically.`)
  console.log(`  finished=${reapplied.manifest.counts.finishedFixtures}, scheduled=${reapplied.manifest.counts.scheduledFixtures}`)
  console.log(`  sourceLastUpdatedAt=${reapplied.manifest.sourceLastUpdatedAt}`)
  console.log(`  Next: npm run verify:static-football && npm run predictions:pl:evaluate`)
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
