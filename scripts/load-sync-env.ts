/**
 * Loads `.env.sync` into `process.env` for the local CLI sync scripts.
 *
 * `.env.sync` holds the server secrets (FOOTBALL_DATA_API_KEY) that must NOT
 * be auto-loaded by `next build`. Next.js only auto-loads `.env`, `.env.local`
 * and their per-mode variants — it never loads `.env.sync` — so keeping the
 * secrets here keeps them out of the `.next` build artifacts.
 *
 * This is a minimal, dependency-free loader: it only sets a variable when it is
 * not already present in `process.env` (so an explicit shell/CI env still
 * wins), skips blank lines and comments, and never logs any values.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export function loadSyncEnv(root: string = process.cwd()): void {
  const envPath = join(root, ".env.sync")
  if (!existsSync(envPath)) return

  for (const rawLine of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue

    const eq = line.indexOf("=")
    if (eq <= 0) continue

    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}
