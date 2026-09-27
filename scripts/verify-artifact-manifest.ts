#!/usr/bin/env tsx
/**
 * Verify an artifact handed between GitHub Actions jobs against its
 * `artifact-manifest.json`.
 *
 *   --data-update <dir>                         (commit job)
 *       Every carried data file must exist with the recorded hash, no extra
 *       file may be present, and `manifest.sourceCommit` must equal HEAD.
 *
 *   --static-export <dir> --data-root <root>    (deploy job)
 *       The `out/` tree must match the recorded file set and hash, and the
 *       committed data files under `root` must hash to the values the export
 *       was built from.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  type ArtifactManifest,
  verifyCommittedDataMatches,
  verifyDataUpdateArtifact,
  verifyStaticExportArtifact,
} from "./artifact-contract"
import { gitRevParse } from "./historical-inputs"

function argAfter(args: string[], flag: string): string | null {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}

function main(): void {
  const args = process.argv.slice(2)
  const dataUpdateDir = argAfter(args, "--data-update")
  const staticExportDir = argAfter(args, "--static-export")
  const dataRoot = argAfter(args, "--data-root")

  // The ledger travels inside each artifact, so read it from the artifact dir.
  const manifestDir = dataUpdateDir ?? staticExportDir
  if (!manifestDir) {
    console.error("usage: verify-artifact-manifest --data-update <dir> | --static-export <dir> --data-root <root>")
    process.exit(2)
  }
  const manifest = JSON.parse(
    readFileSync(join(manifestDir, "artifact-manifest.json"), "utf8"),
  ) as ArtifactManifest

  if (dataUpdateDir) {
    const head = gitRevParse("HEAD")
    if (manifest.sourceCommit !== head) {
      console.error(`artifact sourceCommit ${manifest.sourceCommit} does not match HEAD ${head}`)
      process.exit(1)
    }
    verifyDataUpdateArtifact(manifest, dataUpdateDir)
    console.log(`data-update artifact verified (${dataUpdateDir})`)
    return
  }

  if (staticExportDir && dataRoot) {
    verifyStaticExportArtifact(manifest, staticExportDir)
    verifyCommittedDataMatches(manifest, dataRoot)
    console.log(`static-export artifact verified and consistent with committed data (${dataRoot})`)
    return
  }

  console.error("usage: verify-artifact-manifest --data-update <dir> | --static-export <dir> --data-root <root>")
  process.exit(2)
}

main()
