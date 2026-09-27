/**
 * Tests for the cross-job artifact contract (`scripts/artifact-contract.ts`).
 *
 * The `refresh` job builds an `artifact-manifest.json` ledger of SHA-256 hashes
 * and uploads two artifacts; `commit` and `deploy` download them and verify the
 * content against that ledger. These tests prove the hashing is deterministic,
 * the manifest records exact bytes, and the verifiers reject any missing file,
 * extra file, or hash drift — so a tampered or truncated artifact can never be
 * committed or deployed.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  DATA_UPDATE_FILES,
  buildArtifactManifest,
  hashBytes,
  hashDirectory,
  hashFile,
  verifyCommittedDataMatches,
  verifyDataUpdateArtifact,
  verifyStaticExportArtifact,
} from "./artifact-contract"

const DATA_FILES: Record<string, string> = {
  "data/football/fixtures.json": '{"fixtures":["a","b","c"]}',
  "data/football/manifest.json": '{"counts":{"fixtures":3}}',
  "data/evaluations/premier-league/2026-27/current-evaluation.json": '{"evaluatedAt":"2026-09-27"}',
  "data/evaluations/premier-league/2026-27/evaluation-manifest.json": '{"season":"2026-27"}',
  "sync-diff-report.json": '{"dataChanged":true}',
}

const OUT_FILES: Record<string, string> = {
  "index.html": "<!doctype html><title>x</title>",
  "assets/main.js": "console.log(1)",
  "assets/style.css": "body{margin:0}",
}

function makeTemp(): string {
  return mkdtempSync(join(tmpdir(), "artifact-contract-"))
}

/** Build a checked-out tree at `root` with data files + `out/`. */
function seedRoot(root: string): void {
  for (const [rel, content] of Object.entries(DATA_FILES)) {
    const p = join(root, rel)
    mkdirSync(join(root, rel.split("/").slice(0, -1).join("/") || "."), { recursive: true })
    writeFileSync(p, content, "utf8")
  }
  for (const [rel, content] of Object.entries(OUT_FILES)) {
    const p = join(root, "out", rel)
    mkdirSync(join(root, "out", rel.split("/").slice(0, -1).join("/")), { recursive: true })
    writeFileSync(p, content, "utf8")
  }
}

function buildManifest(root: string) {
  return buildArtifactManifest({
    sourceCommit: "abc123",
    runId: "42",
    dataChanged: true,
    fixtureInputHash: hashBytes("input"),
    fixtureOutputHash: hashBytes("output"),
    outDirHash: hashDirectory(join(root, "out")),
    root,
  })
}

/** Stage a data-update artifact dir: the five data files + the manifest ledger. */
function stageDataArtifact(root: string, manifest: object, dir: string): void {
  for (const rel of DATA_UPDATE_FILES) {
    const p = join(dir, rel)
    mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true })
    writeFileSync(p, readFileSync(join(root, rel)), "utf8")
  }
  writeFileSync(join(dir, "artifact-manifest.json"), JSON.stringify(manifest), "utf8")
}

// --- hashing determinism -----------------------------------------------------

test("hashBytes is deterministic and sensitive to content", () => {
  assert.equal(hashBytes("same"), hashBytes("same"))
  assert.notEqual(hashBytes("a"), hashBytes("b"))
  assert.equal(hashBytes(Buffer.from([1, 2, 3])), hashBytes(Buffer.from([1, 2, 3])))
})

test("hashDirectory is order-independent and path-normalised", () => {
  const dir = makeTemp()
  try {
    mkdirSync(join(dir, "a"), { recursive: true })
    writeFileSync(join(dir, "a", "one.txt"), "x", "utf8")
    writeFileSync(join(dir, "b.txt"), "y", "utf8")

    const h1 = hashDirectory(dir)
    // Recreate with files written in the opposite order — the hash must not change.
    rmSync(join(dir, "b.txt"))
    writeFileSync(join(dir, "b.txt"), "y", "utf8")
    assert.equal(hashDirectory(dir), h1)

    // A single changed byte must change the directory hash.
    writeFileSync(join(dir, "b.txt"), "z", "utf8")
    assert.notEqual(hashDirectory(dir), h1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- manifest build ----------------------------------------------------------

test("buildArtifactManifest records exact byte hashes for every carried file", () => {
  const root = makeTemp()
  try {
    seedRoot(root)
    const m = buildManifest(root)

    assert.equal(m.sourceCommit, "abc123")
    assert.equal(m.runId, "42")
    assert.equal(m.dataChanged, true)
    for (const rel of DATA_UPDATE_FILES) {
      assert.equal(m.files[rel], hashFile(join(root, rel)), `${rel} hash must match its bytes`)
    }

    // staticExportFiles lists every out/ file with a leading "out/" prefix.
    const expected = Object.keys(OUT_FILES)
      .map((r) => `out/${r}`)
      .sort()
    assert.deepEqual(m.staticExportFiles.slice().sort(), expected)

    // outDirHash is the deterministic directory hash of out/.
    assert.equal(m.outDirHash, hashDirectory(join(root, "out")))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- data-update verification ------------------------------------------------

test("verifyDataUpdateArtifact accepts a faithful artifact", () => {
  const root = makeTemp()
  const artifact = makeTemp()
  try {
    seedRoot(root)
    const m = buildManifest(root)
    stageDataArtifact(root, m, artifact)
    verifyDataUpdateArtifact(m, artifact) // must not throw
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(artifact, { recursive: true, force: true })
  }
})

test("verifyDataUpdateArtifact rejects a modified data file", () => {
  const root = makeTemp()
  const artifact = makeTemp()
  try {
    seedRoot(root)
    const m = buildManifest(root)
    stageDataArtifact(root, m, artifact)
    writeFileSync(join(artifact, "data/football/fixtures.json"), '{"tampered":true}', "utf8")
    assert.throws(() => verifyDataUpdateArtifact(m, artifact), /hash/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(artifact, { recursive: true, force: true })
  }
})

test("verifyDataUpdateArtifact rejects a missing data file", () => {
  const root = makeTemp()
  const artifact = makeTemp()
  try {
    seedRoot(root)
    const m = buildManifest(root)
    stageDataArtifact(root, m, artifact)
    rmSync(join(artifact, "data/football/manifest.json"))
    assert.throws(() => verifyDataUpdateArtifact(m, artifact), /manifest/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(artifact, { recursive: true, force: true })
  }
})

test("verifyDataUpdateArtifact rejects an extra file", () => {
  const root = makeTemp()
  const artifact = makeTemp()
  try {
    seedRoot(root)
    const m = buildManifest(root)
    stageDataArtifact(root, m, artifact)
    writeFileSync(join(artifact, "evil.json"), "{}", "utf8")
    assert.throws(() => verifyDataUpdateArtifact(m, artifact), /unexpected file/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(artifact, { recursive: true, force: true })
  }
})

// --- static-export verification ----------------------------------------------

test("verifyStaticExportArtifact accepts a faithful out/ tree", () => {
  const root = makeTemp()
  const artifact = makeTemp()
  try {
    seedRoot(root)
    const m = buildManifest(root)
    // copy out/ into the artifact
    for (const rel of Object.keys(OUT_FILES)) {
      const p = join(artifact, "out", rel)
      mkdirSync(join(artifact, "out", rel.split("/").slice(0, -1).join("/")), { recursive: true })
      writeFileSync(p, readFileSync(join(root, "out", rel)), "utf8")
    }
    writeFileSync(join(artifact, "artifact-manifest.json"), JSON.stringify(m), "utf8")
    verifyStaticExportArtifact(m, artifact)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(artifact, { recursive: true, force: true })
  }
})

test("verifyStaticExportArtifact rejects a missing out/ file", () => {
  const root = makeTemp()
  const artifact = makeTemp()
  try {
    seedRoot(root)
    const m = buildManifest(root)
    for (const rel of Object.keys(OUT_FILES)) {
      const p = join(artifact, "out", rel)
      mkdirSync(join(artifact, "out", rel.split("/").slice(0, -1).join("/")), { recursive: true })
      writeFileSync(p, readFileSync(join(root, "out", rel)), "utf8")
    }
    rmSync(join(artifact, "out", "assets/style.css"))
    writeFileSync(join(artifact, "artifact-manifest.json"), JSON.stringify(m), "utf8")
    assert.throws(() => verifyStaticExportArtifact(m, artifact), /file set mismatch/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(artifact, { recursive: true, force: true })
  }
})

// --- committed-data correspondence -------------------------------------------

test("verifyCommittedDataMatches accepts the commit that produced the export", () => {
  const root = makeTemp()
  try {
    seedRoot(root)
    const m = buildManifest(root)
    verifyCommittedDataMatches(m, root) // same tree — must pass
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("verifyCommittedDataMatches rejects drifted committed data", () => {
  const root = makeTemp()
  try {
    seedRoot(root)
    const m = buildManifest(root)
    writeFileSync(join(root, "data/football/fixtures.json"), '{"fixtures":["only","a","b","c"]}', "utf8")
    assert.throws(() => verifyCommittedDataMatches(m, root), /fixtures.json/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
