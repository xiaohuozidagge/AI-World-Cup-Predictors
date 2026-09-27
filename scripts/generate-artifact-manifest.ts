#!/usr/bin/env tsx
/**
 * Build the `artifact-manifest.json` ledger that anchors the cross-job artifact
 * hand-off. Run in the `refresh` job after sync + evaluate + build, so it reads
 * the exact bytes that were just produced.
 *
 * Inputs: `sync-diff-report.json` (written by the sync CLI) and the checked-out
 * tree (`data/football/*.json`, the evaluation overlay and `out/`).
 * Output: `artifact-manifest.json` at the repo root (never committed).
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { buildArtifactManifest, hashDirectory } from "./artifact-contract"
import { gitRevParse } from "./historical-inputs"

const ROOT = process.cwd()

interface SyncDiffReport {
  dataChanged: boolean
  inputHash: string
  outputHash: string
}

function main(): void {
  const report = JSON.parse(readFileSync(join(ROOT, "sync-diff-report.json"), "utf8")) as SyncDiffReport

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
