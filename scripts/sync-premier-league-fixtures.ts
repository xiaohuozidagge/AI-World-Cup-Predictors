#!/usr/bin/env tsx
/**
 * Premier League in-season fixture sync CLI.
 *
 *   npm run football:pl:sync:dry-run                          — live dry-run (no write)
 *   npm run football:pl:sync:dry-run -- --source-file=<path>  — offline dry-run
 *   npm run football:pl:sync:dry-run -- --report-file=<path>  — dry-run + machine report
 *   npm run football:pl:sync -- --apply                       — live apply (explicit)
 *   npm run football:pl:sync -- --apply --source-file=<path>  — offline apply
 *
 * By default NOTHING is written to disk: the diff is printed to stdout only.
 * A machine-readable report is written ONLY when `--report-file=<path>` names an
 * explicit, non-root location (the GitHub Actions job passes `$RUNNER_TEMP/...`),
 * so a dry-run is a true zero-write operation and no `sync-diff-report.json` is
 * ever dropped into the working tree.
 *
 * The token is read only from `FOOTBALL_DATA_API_KEY` (via the existing client,
 * optionally seeded from `.env.sync` by `loadSyncEnv`). It is never logged.
 *
 * The process exits by setting `process.exitCode` and returning naturally — never
 * via a forced `process.exit()`, so the HTTP client's sockets and timers tear
 * down cleanly (a forced exit raced libuv's handle teardown on Windows).
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path"

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

/** A user-facing CLI error that maps to a specific exit code. */
class CliError extends Error {
  readonly exitCode: number
  constructor(exitCode: number, message: string) {
    super(message)
    this.name = "CliError"
    this.exitCode = exitCode
  }
}

/**
 * Persist a machine-readable diff report to an explicit path for the artifact
 * pipeline. Only ever called when `--report-file` was passed; never to a default
 * location.
 */
function writeSyncDiffReport(diff: SyncDiff, apply: boolean, targetPath: string): void {
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
  writeFileSync(targetPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
}

interface CliArgs {
  apply: boolean
  sourceFile: string | null
  reportFile: string | null
}

function parseArgs(argv: string[]): CliArgs {
  let apply = false
  let sourceFile: string | null = null
  let reportFile: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--apply") apply = true
    else if (a === "--source-file") {
      if (i + 1 < argv.length) sourceFile = argv[++i]
    } else if (a.startsWith("--source-file=")) {
      sourceFile = a.slice("--source-file=".length)
    } else if (a === "--report-file") {
      if (i + 1 < argv.length) reportFile = argv[++i]
    } else if (a.startsWith("--report-file=")) {
      reportFile = a.slice("--report-file=".length)
    }
  }
  return { apply, sourceFile, reportFile }
}

/**
 * Validate and resolve `--report-file`. The report must target an explicit,
 * non-root location: path escape (`..`), the repo root and tracked `data/` are
 * rejected so the CLI can never silently drop a file into the working tree.
 */
function resolveReportFilePath(flag: string, root: string): string {
  const normalized = normalize(flag)
  if (normalized.split(/[\\/]/).includes("..")) {
    throw new CliError(2, `--report-file path must not escape the working directory (contains ".."): ${flag}`)
  }
  const abs = isAbsolute(normalized) ? normalized : resolve(root, normalized)
  if (dirname(abs).toLowerCase() === root.toLowerCase()) {
    throw new CliError(2, `--report-file must not target the repo root (use a temp dir): ${flag}`)
  }
  const relNorm = relative(root, abs).split(/[\\/]/).join("/")
  if (relNorm === "data" || relNorm.startsWith("data/")) {
    throw new CliError(2, `--report-file must not target tracked data/ (use a temp dir): ${flag}`)
  }
  return abs
}

function loadOfflineMatches(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw new CliError(2, `cannot read --source-file ${path}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new CliError(2, `--source-file ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (Array.isArray(parsed)) return parsed
  if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { matches?: unknown }).matches)) {
    return (parsed as { matches: unknown[] }).matches
  }
  throw new CliError(2, `--source-file ${path} must be an array or { matches: [...] }`)
}

/** Fingerprint the two target files so dry-run can prove it never touched them. */
function dataFileFingerprint(root: string): string {
  const dir = join(root, "data", "football")
  const fixtures = readFileSync(join(dir, "fixtures.json")).toString("hex")
  const manifest = readFileSync(join(dir, "manifest.json")).toString("hex")
  return `${fixtures}:${manifest}`
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const root = process.cwd()
  const reportFile = args.reportFile !== null ? resolveReportFilePath(args.reportFile, root) : null

  const offline = args.sourceFile !== null ? loadOfflineMatches(args.sourceFile) : undefined

  let matches
  try {
    matches = await fetchPremierLeagueMatches({ offlineMatches: offline })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (offline === undefined && /FOOTBALL_DATA_API_KEY|not configured/i.test(msg)) {
      console.error(`LIVE_DRY_RUN_NOT_EXECUTED: ${msg}`)
      console.error(`Provide a --source-file=<path> fixture for an offline run, or set FOOTBALL_DATA_API_KEY.`)
      return 0
    }
    console.error(`ERROR: ${msg}`)
    return 2
  }

  const before = dataFileFingerprint(root)
  const snapshot = loadLocalSnapshot(root)
  const appliedAt = args.apply ? new Date().toISOString() : null
  const diff = computeSyncDiff(matches, snapshot, appliedAt)

  if (reportFile !== null) {
    writeSyncDiffReport(diff, args.apply, reportFile)
  }

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
    return 1
  }

  if (!args.apply) {
    if (diff.changes.length === 0 && diff.hardFailures.length === 0) {
      console.log(`\nNo data change — nothing to apply.`)
    } else {
      console.log(`\nDry-run only. Re-run with --apply to write.`)
    }
    return diff.ok ? 0 : 1
  }

  // --- apply path ---
  if (!diff.ok) {
    console.error("\nRefusing to apply: identity/validation failures present.")
    return 1
  }
  if (!diff.safeToApply) {
    console.error("\nRefusing to apply: FINISHED score correction(s) need manual confirmation.")
    return 1
  }
  if (diff.changes.length === 0) {
    console.log("\nNo semantic change — nothing to write, no timestamp churn, no commit/build/deploy.")
    return 0
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
    return 1
  }

  console.log(`\nApplied ${diff.changes.length} fixture change(s) atomically.`)
  console.log(`  finished=${reapplied.manifest.counts.finishedFixtures}, scheduled=${reapplied.manifest.counts.scheduledFixtures}`)
  console.log(`  sourceLastUpdatedAt=${reapplied.manifest.sourceLastUpdatedAt}`)
  console.log(`  Next: npm run verify:static-football && npm run predictions:pl:evaluate`)
  return 0
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    if (err instanceof CliError) {
      console.error(`ERROR: ${err.message}`)
      process.exitCode = err.exitCode
    } else {
      console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
  })
