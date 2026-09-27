#!/usr/bin/env tsx
/**
 * Build the `artifact-manifest.json` ledger that anchors the cross-job artifact
 * hand-off. Run in the `refresh` job after sync + evaluate + build, so it reads
 * the exact bytes that were just produced.
 *
 * Inputs: the sync diff report (a transient file the sync CLI wrote to an
 * explicit `--report-file` path — never the repo root) and the checked-out tree
 * (`data/football/*.json`, the evaluation overlay and `out/`).
 * Output: `artifact-manifest.json` at the repo root (never committed).
 *
 * The report path is taken from `--report-file=<path>` or `SYNC_REPORT_FILE`,
 * which the GitHub Actions job points at `$RUNNER_TEMP`. It is an error to run
 * without one: the script must not silently read a stale repo-root report.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

import { buildArtifactManifest, hashDirectory } from "./artifact-contract"
import { gitRevParse } from "./historical-inputs"

const ROOT = process.cwd()

interface SyncDiffReport {
  dataChanged: boolean
  inputHash: string
  outputHash: string
}

function resolveReportPath(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--report-file" && i + 1 < argv.length) return argv[i + 1]
    if (argv[i].startsWith("--report-file=")) return argv[i].slice("--report-file=".length)
  }
  const env = process.env.SYNC_REPORT_FILE
  if (env) return env
  console.error(
    "ERROR: no report path. Pass --report-file=<path> or set SYNC_REPORT_FILE " +
      "(the sync CLI writes the report to $RUNNER_TEMP, never the repo root).",
  )
  process.exitCode = 2
  throw new Error("missing report path")
}

function main(): void {
  const flag = resolveReportPath(process.argv.slice(2))
  const reportPath = isAbsolute(flag) ? flag : resolve(ROOT, flag)

  let report: SyncDiffReport
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8")) as SyncDiffReport
  } catch (err) {
    console.error(`ERROR: cannot read sync diff report at ${reportPath}: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 2
    throw err
  }

  let sourceCommit = "unavailable"
  try {
    sourceCommit = gitRevParse("HEAD")
  } catch {
    // non-git checkout; provenance is best-effort
  }

  const outDirHash = hashDirectory(join(ROOT, "out"))
  const manifest = buildArtifactManifest({
    sourceCommit,
    runId: process.env.GITHUB_RUN_ID ?? "local",
    dataChanged: report.dataChanged,
    fixtureInputHash: report.inputHash,
    fixtureOutputHash: report.outputHash,
    outDirHash,
    root: ROOT,
  })

  writeFileSync(join(ROOT, "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  console.log(
    `artifact-manifest.json written — dataChanged=${manifest.dataChanged}, ` +
      `sourceCommit=${manifest.sourceCommit}, runId=${manifest.runId}`,
  )
}

main()
