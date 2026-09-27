/**
 * Fault-injection tests for the multi-file transactional writer.
 *
 * Every case runs against a fresh temporary directory so no real
 * `data/football` / `data/evaluations` file is ever touched. The `hooks` are the
 * injection points: each throws at exactly one stage to prove the stage maps to
 * the documented error code and — critically — that a failure leaves the
 * original files untouched (or reports rollback failure explicitly).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  SYNC_LOCKED,
  TRANSACTION_COMMIT_FAILED,
  TRANSACTION_ROLLBACK_FAILED,
  TRANSACTION_STAGE_FAILED,
  TRANSACTION_VERIFY_FAILED,
  TransactionError,
  transactionalWrite,
  type TransactionFile,
} from "./transactional-write"

const LOCK = ".sync-transaction.lock"
const TMP = ".sync-transaction.tmp"
const BACKUP = ".sync-transaction.backup"

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "txn-"))
}

function writeOriginal(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(join(p, ".."), { recursive: true })
  writeFileSync(p, content, "utf8")
}

function readFormal(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8")
}

/** A no-op validator that nonetheless proves every file is valid JSON. */
function jsonValidator(files: ReadonlyMap<string, string>): void {
  for (const [, content] of files) JSON.parse(content)
}

function noResidue(root: string): void {
  assert.equal(existsSync(join(root, LOCK)), false, "lock file must be removed")
  assert.equal(existsSync(join(root, TMP)), false, "temp dir must be removed")
  assert.equal(existsSync(join(root, BACKUP)), false, "backup dir must be removed")
}

const FIXTURES = "data/football/fixtures.json"
const MANIFEST = "data/football/manifest.json"
const EVAL = "data/evaluations/premier-league/2026-27/current-evaluation.json"

const ORIGINALS: Record<string, string> = {
  [FIXTURES]: JSON.stringify([{ id: "fx-1", status: "SCHEDULED" }]),
  [MANIFEST]: JSON.stringify({ counts: { fixtures: 1, finishedFixtures: 0 } }),
  [EVAL]: JSON.stringify({ officialAccuracy: null }),
}

function filesFor(overrides: Record<string, string>): TransactionFile[] {
  return [
    { relativePath: FIXTURES, content: overrides[FIXTURES] ?? ORIGINALS[FIXTURES] },
    { relativePath: MANIFEST, content: overrides[MANIFEST] ?? ORIGINALS[MANIFEST] },
    { relativePath: EVAL, content: overrides[EVAL] ?? ORIGINALS[EVAL] },
  ]
}

function seedOriginals(root: string): void {
  for (const [rel, content] of Object.entries(ORIGINALS)) writeOriginal(root, rel, content)
}

function assertOriginalsIntact(root: string): void {
  for (const [rel, content] of Object.entries(ORIGINALS)) {
    assert.equal(readFormal(root, rel), content, `original ${rel} must be unchanged`)
  }
}

// --- tests -------------------------------------------------------------------

test("lock acquisition failure → SYNC_LOCKED, originals untouched", () => {
  const root = makeRoot()
  seedOriginals(root)
  writeOriginal(root, LOCK, "123") // a concurrent sync already holds the lock

  assert.throws(
    () => transactionalWrite({ root, files: filesFor({}), validate: jsonValidator }),
    (err: unknown) => err instanceof TransactionError && err.code === SYNC_LOCKED,
  )
  assertOriginalsIntact(root)
})

test("first temp write failure → TRANSACTION_STAGE_FAILED, originals untouched", () => {
  const root = makeRoot()
  seedOriginals(root)

  assert.throws(
    () =>
      transactionalWrite({
        root,
        files: filesFor({}),
        validate: jsonValidator,
        hooks: { beforeTempWrite: (rel) => { if (rel === FIXTURES) throw new Error("disk full") } },
      }),
    (err: unknown) => err instanceof TransactionError && err.code === TRANSACTION_STAGE_FAILED,
  )
  assertOriginalsIntact(root)
  noResidue(root)
})

test("temp schema failure → TRANSACTION_STAGE_FAILED, originals untouched", () => {
  const root = makeRoot()
  seedOriginals(root)

  assert.throws(
    () =>
      transactionalWrite({
        root,
        files: filesFor({}),
        validate: () => { throw new Error("schema mismatch: finished count disagrees") },
      }),
    (err: unknown) => err instanceof TransactionError && err.code === TRANSACTION_STAGE_FAILED,
  )
  assertOriginalsIntact(root)
  noResidue(root)
})

test("first formal replace failure → TRANSACTION_COMMIT_FAILED, originals untouched", () => {
  const root = makeRoot()
  seedOriginals(root)

  assert.throws(
    () =>
      transactionalWrite({
        root,
        files: filesFor({}),
        validate: jsonValidator,
        hooks: { beforeCommit: (rel) => { if (rel === FIXTURES) throw new Error("rename blocked") } },
      }),
    (err: unknown) => err instanceof TransactionError && err.code === TRANSACTION_COMMIT_FAILED,
  )
  assertOriginalsIntact(root)
  noResidue(root)
})

test("first succeeds, second replace fails → TRANSACTION_COMMIT_FAILED, first is rolled back", () => {
  const root = makeRoot()
  seedOriginals(root)
  const newFixtures = JSON.stringify([{ id: "fx-1", status: "FINISHED" }])

  assert.throws(
    () =>
      transactionalWrite({
        root,
        files: filesFor({ [FIXTURES]: newFixtures }),
        validate: jsonValidator,
        hooks: { beforeCommit: (rel) => { if (rel === MANIFEST) throw new Error("rename blocked") } },
      }),
    (err: unknown) => err instanceof TransactionError && err.code === TRANSACTION_COMMIT_FAILED,
  )
  // Both files must be restored — the first commit was undone.
  assertOriginalsIntact(root)
  noResidue(root)
})

test("final re-verify failure → TRANSACTION_VERIFY_FAILED, all files rolled back", () => {
  const root = makeRoot()
  seedOriginals(root)
  const newFixtures = JSON.stringify([{ id: "fx-1", status: "FINISHED" }])

  assert.throws(
    () =>
      transactionalWrite({
        root,
        files: filesFor({ [FIXTURES]: newFixtures }),
        validate: jsonValidator,
        hooks: { beforeVerify: () => { throw new Error("post-commit read-back failed") } },
      }),
    (err: unknown) => err instanceof TransactionError && err.code === TRANSACTION_VERIFY_FAILED,
  )
  assertOriginalsIntact(root)
  noResidue(root)
})

test("rollback failure → TRANSACTION_ROLLBACK_FAILED", () => {
  const root = makeRoot()
  seedOriginals(root)

  assert.throws(
    () =>
      transactionalWrite({
        root,
        files: filesFor({ [FIXTURES]: JSON.stringify([{ id: "fx-1", status: "FINISHED" }]) }),
        validate: jsonValidator,
        hooks: {
          beforeCommit: (rel) => { if (rel === MANIFEST) throw new Error("rename blocked") },
          beforeRollback: () => { throw new Error("restore failed") },
        },
      }),
    (err: unknown) => err instanceof TransactionError && err.code === TRANSACTION_ROLLBACK_FAILED,
  )
})

test("success leaves no tmp/backup/lock residue and writes new content", () => {
  const root = makeRoot()
  seedOriginals(root)
  const newFixtures = JSON.stringify([{ id: "fx-1", status: "FINISHED" }])
  const newManifest = JSON.stringify({ counts: { fixtures: 1, finishedFixtures: 1 } })
  const newEval = JSON.stringify({ officialAccuracy: 0.5 })

  transactionalWrite({
    root,
    files: filesFor({ [FIXTURES]: newFixtures, [MANIFEST]: newManifest, [EVAL]: newEval }),
    validate: jsonValidator,
  })

  assert.equal(readFormal(root, FIXTURES), newFixtures)
  assert.equal(readFormal(root, MANIFEST), newManifest)
  assert.equal(readFormal(root, EVAL), newEval)
  noResidue(root)
})

test("same input applied twice is byte-identical", () => {
  const newFixtures = JSON.stringify([{ id: "fx-1", status: "FINISHED" }])
  const newManifest = JSON.stringify({ counts: { fixtures: 1, finishedFixtures: 1 } })
  const newEval = JSON.stringify({ officialAccuracy: 0.5 })
  const overrides = { [FIXTURES]: newFixtures, [MANIFEST]: newManifest, [EVAL]: newEval }

  const rootA = makeRoot()
  seedOriginals(rootA)
  transactionalWrite({ root: rootA, files: filesFor(overrides), validate: jsonValidator })

  const rootB = makeRoot()
  seedOriginals(rootB)
  transactionalWrite({ root: rootB, files: filesFor(overrides), validate: jsonValidator })

  assert.equal(sha256(readFormal(rootA, FIXTURES)), sha256(readFormal(rootB, FIXTURES)))
  assert.equal(sha256(readFormal(rootA, MANIFEST)), sha256(readFormal(rootB, MANIFEST)))
  assert.equal(sha256(readFormal(rootA, EVAL)), sha256(readFormal(rootB, EVAL)))

  // And no residue in either tree.
  noResidue(rootA)
  noResidue(rootB)
})

test("a path that escapes root is rejected", () => {
  const root = makeRoot()
  seedOriginals(root)

  assert.throws(
    () =>
      transactionalWrite({
        root,
        files: [{ relativePath: "../escape.json", content: "{}" }],
        validate: jsonValidator,
      }),
    /escapes root/,
  )
  // The lock must not be left behind after a pre-flight path rejection.
  assert.equal(existsSync(join(root, LOCK)), false)
})
