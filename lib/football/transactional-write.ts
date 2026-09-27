/**
 * True multi-file transactional writer for the static data pipeline.
 *
 * The in-season refresh updates a *group* of files — `fixtures.json`,
 * `manifest.json` and the settlement overlay under `data/evaluations/` — that
 * must change together or not at all. A sequence of `renameSync` calls cannot
 * guarantee that: a crash or error halfway through leaves the group torn (new
 * fixtures with an old manifest, or vice-versa).
 *
 * `transactionalWrite` commits a group of files as one unit using the
 * write-ahead-then-rollback pattern:
 *
 *   1. acquire a process lock (fail fast — a concurrent sync is an error, not a
 *      queue);
 *   2. write every new file into one temporary transaction directory;
 *   3. re-read the temporary files and run the caller's `validate` (schema,
 *      hash and cross-file relationships);
 *   4. save a recovery copy of every original file;
 *   5. replace the real files one by one;
 *   6. re-read the real files and run `validate` again;
 *   7. on success, delete the temporary directory, recovery copies and lock;
 *   8. on any failure, restore every original from its recovery copy;
 *   9. rollback failure is itself a distinct, explicit error;
 *  10. the temporary directory and lock are always cleaned up, success or not.
 *
 * The module is pure Node `fs` (no network, no clock, no environment), so it is
 * fully unit-testable with fault injection (see `transactional-write.test.ts`).
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, normalize } from "node:path"

// --- error codes -------------------------------------------------------------

export const SYNC_LOCKED = "SYNC_LOCKED"
export const TRANSACTION_STAGE_FAILED = "TRANSACTION_STAGE_FAILED"
export const TRANSACTION_COMMIT_FAILED = "TRANSACTION_COMMIT_FAILED"
export const TRANSACTION_VERIFY_FAILED = "TRANSACTION_VERIFY_FAILED"
export const TRANSACTION_ROLLBACK_FAILED = "TRANSACTION_ROLLBACK_FAILED"

export class TransactionError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "TransactionError"
    this.code = code
  }
}

// --- shapes ------------------------------------------------------------------

export interface TransactionFile {
  /** Path relative to `root`. Must not escape `root` (no `..` traversal). */
  relativePath: string
  /** Exact bytes to write. Written verbatim — no re-serialization. */
  content: string
}

export interface TransactionHooks {
  /** Throw to simulate a failure while writing the given temp file. */
  beforeTempWrite?: (relativePath: string) => void
  /** Throw to simulate a failure while backing up the given original. */
  beforeBackup?: (relativePath: string) => void
  /** Throw to simulate a failure while replacing the given real file. */
  beforeCommit?: (relativePath: string) => void
  /** Throw to simulate a failure during final re-verification. */
  beforeVerify?: () => void
  /** Throw to simulate a rollback that itself fails. */
  beforeRollback?: () => void
}

export interface TransactionOptions {
  root: string
  files: TransactionFile[]
  /**
   * Schema / hash / cross-file validation. Receives every file's content keyed
   * by `relativePath`. Throw any `Error` to abort; the stage in which it ran
   * determines the resulting error code (stage vs verify).
   */
  validate: (files: ReadonlyMap<string, string>) => void
  /** Lock file path relative to `root`. Defaults to `.sync-transaction.lock`. */
  lockRelativePath?: string
  /** Temp directory path relative to `root`. Defaults to `.sync-transaction.tmp`. */
  tempRelativePath?: string
  /** Backup directory path relative to `root`. Defaults to `.sync-transaction.backup`. */
  backupRelativePath?: string
  /** Test-only fault injection. */
  hooks?: TransactionHooks
}

// --- helpers -----------------------------------------------------------------

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function translate(code: string, err: unknown): TransactionError {
  if (err instanceof TransactionError) return err
  return new TransactionError(code, msg(err))
}

/** Reject `..` or absolute paths so a file entry can never escape `root`. */
function assertSafeRelativePath(relativePath: string): void {
  if (isAbsolute(relativePath)) {
    throw new Error(`transaction file path must be relative: ${relativePath}`)
  }
  const segments = normalize(relativePath).split(/[\\/]/)
  if (segments.includes("..")) {
    throw new Error(`transaction file path escapes root: ${relativePath}`)
  }
}

// --- implementation ----------------------------------------------------------

export function transactionalWrite(options: TransactionOptions): void {
  const root = options.root
  const files = options.files
  const validate = options.validate
  const hooks = options.hooks ?? {}

  for (const f of files) assertSafeRelativePath(f.relativePath)

  const lockPath = join(root, options.lockRelativePath ?? ".sync-transaction.lock")
  const txDir = join(root, options.tempRelativePath ?? ".sync-transaction.tmp")
  const backupDir = join(root, options.backupRelativePath ?? ".sync-transaction.backup")

  // 1. Acquire the process lock. `wx` is atomic and fails (EEXIST) if the lock
  //    already exists — a concurrent sync is reported, never queued or overridden.
  try {
    const fd = openSync(lockPath, "wx")
    try {
      writeFileSync(fd, String(process.pid), "utf8")
    } finally {
      closeSync(fd)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new TransactionError(SYNC_LOCKED, `sync lock already held at ${lockPath}; a concurrent sync is in progress`)
    }
    throw translate(SYNC_LOCKED, err)
  }

  const committed: string[] = []
  let backupMade = false

  const cleanupTempAndLock = (): void => {
    rmSync(txDir, { recursive: true, force: true })
    rmSync(lockPath, { force: true })
  }

  const cleanupBackup = (): void => {
    rmSync(backupDir, { recursive: true, force: true })
  }

  const rollback = (): void => {
    for (const f of files) {
      const formal = join(root, f.relativePath)
      const bak = join(backupDir, f.relativePath)
      if (existsSync(bak)) {
        mkdirSync(dirname(formal), { recursive: true })
        copyFileSync(bak, formal)
      } else if (committed.includes(f.relativePath)) {
        rmSync(formal, { force: true })
      }
    }
  }

  try {
    // 2. Write every new file into one temporary transaction directory.
    try {
      for (const f of files) {
        hooks.beforeTempWrite?.(f.relativePath)
        const tmp = join(txDir, f.relativePath)
        mkdirSync(dirname(tmp), { recursive: true })
        writeFileSync(tmp, f.content, "utf8")
      }
    } catch (err) {
      throw translate(TRANSACTION_STAGE_FAILED, err)
    }

    // 3. Re-read the temp files and validate schema/hash/cross-file relations.
    try {
      const tempContent = new Map<string, string>()
      for (const f of files) {
        const text = readFileSync(join(txDir, f.relativePath), "utf8")
        if (text !== f.content) throw new Error(`temp re-read mismatch for ${f.relativePath}`)
        tempContent.set(f.relativePath, text)
      }
      validate(tempContent)
    } catch (err) {
      throw translate(TRANSACTION_STAGE_FAILED, err)
    }

    // 4. Save recovery copies of every original file.
    try {
      mkdirSync(backupDir, { recursive: true })
      for (const f of files) {
        hooks.beforeBackup?.(f.relativePath)
        const formal = join(root, f.relativePath)
        if (existsSync(formal)) {
          const bak = join(backupDir, f.relativePath)
          mkdirSync(dirname(bak), { recursive: true })
          copyFileSync(formal, bak)
        }
      }
      backupMade = true
    } catch (err) {
      throw translate(TRANSACTION_STAGE_FAILED, err)
    }

    // 5. Replace the real files one by one.
    try {
      for (const f of files) {
        hooks.beforeCommit?.(f.relativePath)
        const formal = join(root, f.relativePath)
        const tmp = join(txDir, f.relativePath)
        mkdirSync(dirname(formal), { recursive: true })
        renameSync(tmp, formal)
        committed.push(f.relativePath)
      }
    } catch (err) {
      throw translate(TRANSACTION_COMMIT_FAILED, err)
    }

    // 6. Re-read the real files and validate once more.
    try {
      hooks.beforeVerify?.()
      const formalContent = new Map<string, string>()
      for (const f of files) {
        const text = readFileSync(join(root, f.relativePath), "utf8")
        if (text !== f.content) throw new Error(`formal re-read mismatch for ${f.relativePath}`)
        formalContent.set(f.relativePath, text)
      }
      validate(formalContent)
    } catch (err) {
      throw translate(TRANSACTION_VERIFY_FAILED, err)
    }

    // 7. Success — delete temp directory, recovery copies and lock.
    cleanupTempAndLock()
    cleanupBackup()
  } catch (err) {
    // 8. Restore every original we may have touched.
    let rollbackFailed = false
    if (committed.length > 0 || backupMade) {
      try {
        hooks.beforeRollback?.()
        rollback()
      } catch {
        rollbackFailed = true
      }
    }
    // 10. Always clean up the temp directory and lock, success or failure.
    cleanupTempAndLock()

    if (rollbackFailed) {
      // Keep the recovery copies for manual repair — they are the safety net.
      throw new TransactionError(TRANSACTION_ROLLBACK_FAILED, `rollback failed while recovering from: ${msg(err)}`)
    }
    // Rollback succeeded (or nothing to roll back): recovery copies are spent.
    cleanupBackup()
    throw translate(TRANSACTION_STAGE_FAILED, err)
  }
}
