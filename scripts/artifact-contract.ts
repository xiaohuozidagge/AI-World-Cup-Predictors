/**
 * Shared contract for the GitHub Actions artifact hand-off between the
 * `refresh`, `commit` and `deploy` jobs.
 *
 * The three jobs run on separate runners that do not share a filesystem, so the
 * refreshed data and the static export are handed over as artifacts whose
 * *content* is verified from an `artifact-manifest.json` — a small, hash-anchored
 * ledger written by `refresh` and checked by `commit`/`deploy`.
 *
 * Hashing is byte-level SHA-256 and deterministic (directory hashing walks files
 * in sorted order with `/`-normalised relative paths), so the same bytes produce
 * the same hash on any runner.
 */

import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

// --- whitelists --------------------------------------------------------------

/**
 * Exact repo-relative files carried by the `premier-league-data-update` artifact.
 * The sync's machine-readable diff report is a transient hand-off that lives in a
 * runner temp file (never the repo root), so it is deliberately NOT a carried
 * artifact file.
 */
export const DATA_UPDATE_FILES: readonly string[] = [
  "data/football/fixtures.json",
  "data/football/manifest.json",
  "data/evaluations/premier-league/2026-27/current-evaluation.json",
  "data/evaluations/premier-league/2026-27/evaluation-manifest.json",
]

/** The static-export artifact carries `out/**` plus the manifest ledger. */
export const STATIC_EXPORT_MANIFEST_NAME = "artifact-manifest.json"

// --- hashing -----------------------------------------------------------------

export function hashBytes(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}

export function hashFile(path: string): string {
  return hashBytes(readFileSync(path))
}

/**
 * Deterministic recursive directory hash: every file's `/`-normalised relative
 * path and raw bytes, in sorted order. Empty directories are ignored (they carry
 * no content), which is exactly what we want for `out/`.
 */
export function hashDirectory(dir: string): string {
  const files: string[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry)
      if (statSync(p).isDirectory()) walk(p)
      else files.push(p)
    }
  }
  walk(dir)

  const hash = createHash("sha256")
  const sorted = files
    .map((p) => relative(dir, p).split(/[\\/]/).join("/"))
    .sort()
  for (const rel of sorted) {
    hash.update(rel)
    hash.update("\u0000")
    hash.update(readFileSync(join(dir, ...rel.split("/"))))
    hash.update("\u0000")
  }
  return hash.digest("hex")
}

// --- manifest ----------------------------------------------------------------

export interface ArtifactManifest {
  schemaVersion: 1
  sourceCommit: string
  runId: string
  dataChanged: boolean
  fixtureInputHash: string
  fixtureOutputHash: string
  evaluationHash: string
  outDirHash: string
  /** Byte-level SHA-256 of each carried data file, keyed by repo-relative path. */
  files: Record<string, string>
  /** Exact repo-relative files allowed in the static-export artifact (out/**). */
  staticExportFiles: string[]
}

// --- build -------------------------------------------------------------------

export interface BuildArtifactManifestInput {
  sourceCommit: string
  runId: string
  dataChanged: boolean
  fixtureInputHash: string
  fixtureOutputHash: string
  outDirHash: string
  /** The checked-out tree root that the artifacts were staged from. */
  root: string
}

/**
 * Compute the `artifact-manifest.json` from the checked-out tree. Reads every
 * data file and the `out/` directory, hashing their exact bytes.
 */
export function buildArtifactManifest(input: BuildArtifactManifestInput): ArtifactManifest {
  const files: Record<string, string> = {}
  for (const rel of DATA_UPDATE_FILES) {
    files[rel] = hashFile(join(input.root, rel))
  }

  const evaluationHash = hashBytes(
    files["data/evaluations/premier-league/2026-27/current-evaluation.json"] +
      files["data/evaluations/premier-league/2026-27/evaluation-manifest.json"],
  )

  const staticExportFiles = listDirFiles(join(input.root, "out"), "out")

  return {
    schemaVersion: 1,
    sourceCommit: input.sourceCommit,
    runId: input.runId,
    dataChanged: input.dataChanged,
    fixtureInputHash: input.fixtureInputHash,
    fixtureOutputHash: input.fixtureOutputHash,
    evaluationHash,
    outDirHash: input.outDirHash,
    files,
    staticExportFiles,
  }
}

function listDirFiles(dir: string, prefix: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(`${prefix}/${relative(dir, p).split(/[\\/]/).join("/")}`)
    }
  }
  walk(dir)
  return out.sort()
}

// --- verify ------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(`artifact verification failed: ${message}`)
}

/**
 * Verify the downloaded `premier-league-data-update` artifact against the
 * manifest: every expected file must exist with the exact recorded hash, and no
 * extra file (other than the manifest ledger itself) may be present.
 */
export function verifyDataUpdateArtifact(manifest: ArtifactManifest, artifactDir: string): void {
  for (const rel of DATA_UPDATE_FILES) {
    const actual = hashFile(join(artifactDir, rel))
    const expected = manifest.files[rel]
    if (actual !== expected) fail(`${rel}: hash ${actual} != manifest ${expected}`)
  }

  // Reject any extra file.
  const seen = new Set<string>()
  const walk = (d: string, prefix: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry)
      if (statSync(p).isDirectory()) {
        walk(p, `${prefix}${entry}/`)
      } else {
        seen.add(`${prefix}${entry}`)
      }
    }
  }
  walk(artifactDir, "")
  const allowed = new Set([...DATA_UPDATE_FILES, STATIC_EXPORT_MANIFEST_NAME])
  for (const rel of seen) {
    if (!allowed.has(rel)) fail(`unexpected file in artifact: ${rel}`)
  }
}

/**
 * Verify the downloaded `static-export` artifact: the `out/` tree must contain
 * exactly the files the manifest recorded (no extras, none missing) and hash to
 * the recorded `outDirHash`.
 */
export function verifyStaticExportArtifact(manifest: ArtifactManifest, artifactDir: string): void {
  const actualFiles = listDirFiles(join(artifactDir, "out"), "out")
  const expectedFiles = manifest.staticExportFiles.slice().sort()

  if (actualFiles.join("\n") !== expectedFiles.join("\n")) {
    const missing = expectedFiles.filter((f) => !actualFiles.includes(f))
    const extra = actualFiles.filter((f) => !expectedFiles.includes(f))
    fail(
      `out/ file set mismatch — missing ${missing.length} (${missing[0] ?? "none"}), extra ${extra.length} (${extra[0] ?? "none"})`,
    )
  }

  const actualHash = hashDirectory(join(artifactDir, "out"))
  if (actualHash !== manifest.outDirHash) {
    fail(`out/ hash ${actualHash} != manifest ${manifest.outDirHash}`)
  }
}

/**
 * Verify that the data committed to the tree (the four committed data files,
 * excluding any transient report file) still hash to the values the static
 * export was built from. Used by the `deploy` job to prove the `out/` artifact
 * corresponds to the commit that landed, not some stale export.
 */
export function verifyCommittedDataMatches(manifest: ArtifactManifest, root: string): void {
  for (const rel of [
    "data/football/fixtures.json",
    "data/football/manifest.json",
    "data/evaluations/premier-league/2026-27/current-evaluation.json",
    "data/evaluations/premier-league/2026-27/evaluation-manifest.json",
  ]) {
    const actual = hashFile(join(root, rel))
    const expected = manifest.files[rel]
    if (actual !== expected) fail(`${rel}: committed hash ${actual} != manifest ${expected}`)
  }
}
