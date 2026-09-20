/**
 * Downloads the last five complete Premier League seasons from
 * football-data.co.uk into `data/history/premier-league/raw/`.
 *
 * Rules (Phase III, §四/§六):
 * - Only the five fixed `mmz4281/{code}/E0.csv` URLs, downloaded serially.
 * - Each season: one normal request, a reasonable timeout, no infinite retry.
 * - On 403/404/429/5xx, an HTML error page, an empty file, or a bad CSV header,
 *   stop that season without creating fake data and exit non-zero.
 * - Write to a temp file, then atomically replace the official file.
 * - Re-downloads: skip the write when content is unchanged; report when changed.
 * - Logs only season, file size, line count, and success/failure.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { HISTORY_SEASONS } from "../lib/football/history-seasons"
import { REQUIRED_E0_HEADERS } from "../lib/football/history-csv"

const RAW_DIR = join(process.cwd(), "data", "history", "premier-league", "raw")

const failures: string[] = []

function fail(message: string): void {
  failures.push(message)
  console.error(`✗ ${message}`)
}

function looksLikeHtml(text: string): boolean {
  const head = text.trimStart().slice(0, 200).toLowerCase()
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<!")
}

function checkHeader(text: string): boolean {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ""
  const cells = firstLine.split(",").map((c) => c.trim())
  return REQUIRED_E0_HEADERS.every((h) => cells.includes(h))
}

function lineCount(text: string): number {
  return text.split("\n").filter((l) => l.trim().length > 0).length
}

async function downloadSeason(season: string, sourceUrl: string, outFile: string): Promise<void> {
  let res: Response
  try {
    res = await fetch(sourceUrl, { signal: AbortSignal.timeout(30_000) })
  } catch (err) {
    fail(`${season}: request failed (${err instanceof Error ? err.message : String(err)})`)
    return
  }

  if (!res.ok) {
    fail(`${season}: HTTP ${res.status} ${res.statusText}`)
    return
  }

  const text = await res.text()

  if (text.trim().length === 0) {
    fail(`${season}: empty file`)
    return
  }
  if (looksLikeHtml(text)) {
    fail(`${season}: response is HTML, not CSV`)
    return
  }
  if (!checkHeader(text)) {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? ""
    fail(`${season}: CSV header missing required columns — got "${firstLine.slice(0, 120)}"`)
    return
  }

  const size = Buffer.byteLength(text, "utf-8")
  const lines = lineCount(text)

  if (existsSync(outFile)) {
    const existing = readFileSync(outFile, "utf-8")
    if (existing === text) {
      console.log(`✓ ${season}: unchanged (${size} bytes, ${lines} lines)`)
      return
    }
    console.log(`✓ ${season}: changed — overwriting (${size} bytes, ${lines} lines)`)
  } else {
    console.log(`✓ ${season}: downloaded (${size} bytes, ${lines} lines)`)
  }

  const tmpFile = `${outFile}.tmp`
  writeFileSync(tmpFile, text, "utf-8")
  renameSync(tmpFile, outFile)
}

async function main(): Promise<void> {
  mkdirSync(RAW_DIR, { recursive: true })

  for (const spec of HISTORY_SEASONS) {
    await downloadSeason(spec.season, spec.sourceUrl, join(RAW_DIR, `${spec.season}.csv`))
  }

  if (failures.length > 0) {
    console.error(`\nhistory:download failed for ${failures.length} season(s). No data was fabricated.`)
    process.exitCode = 1
    return
  }

  console.log(`\nhistory:download complete — ${HISTORY_SEASONS.length} season(s) in ${RAW_DIR}`)
}

main()
