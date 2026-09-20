/**
 * Imports the five downloaded Premier League CSVs into normalized JSON under
 * `data/history/premier-league/normalized/` and writes a reproducible source
 * manifest (with SHA-256 of each raw CSV) at
 * `data/history/premier-league/manifest.json`.
 *
 * Fully offline and deterministic: the output is a pure function of the raw
 * CSVs and `team-aliases.json`. No runtime clock, no network, no Date.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { HISTORY_COMPETITION_SLUG, HISTORY_SEASONS } from "../lib/football/history-seasons"
import { buildE0HeaderMap, isBlankRow, parseCsv } from "../lib/football/history-csv"
import { normalizeSeason, type HistoryMatch, type TeamAliases } from "../lib/football/history-normalize"

const HISTORY_DIR = join(process.cwd(), "data", "history", "premier-league")
const RAW_DIR = join(HISTORY_DIR, "raw")
const NORMALIZED_DIR = join(HISTORY_DIR, "normalized")

interface SeasonManifestEntry {
  season: string
  sourceUrl: string
  rawFile: string
  normalizedFile: string
  sha256: string
  matches: number
  teams: number
  firstMatchDate: string
  lastMatchDate: string
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex")
}

function collectDates(matches: HistoryMatch[]): { first: string; last: string } {
  const dates = matches.map((m) => m.date).sort()
  return { first: dates[0], last: dates[dates.length - 1] }
}

function main(): void {
  const aliases = readJson<TeamAliases>(join(HISTORY_DIR, "team-aliases.json"))
  mkdirSync(NORMALIZED_DIR, { recursive: true })

  const unionSlugs = new Set<string>()
  const seasonEntries: SeasonManifestEntry[] = []
  let totalMatches = 0

  for (const spec of HISTORY_SEASONS) {
    const rawPath = join(RAW_DIR, `${spec.season}.csv`)
    if (!existsSync(rawPath)) {
      throw new Error(`raw CSV not found: ${rawPath} (run history:download first)`)
    }

    const rawBuffer = readFileSync(rawPath)
    const text = rawBuffer.toString("utf-8")
    const rows = parseCsv(text)
    if (rows.length === 0) throw new Error(`empty CSV: ${spec.season}`)

    const headerMap = buildE0HeaderMap(rows[0])
    const dataRows = rows.slice(1).filter((r) => !isBlankRow(r))
    const matches = normalizeSeason(dataRows, headerMap, spec.season, aliases)

    const normalizedPath = join(NORMALIZED_DIR, `${spec.season}.json`)
    writeFileSync(normalizedPath, JSON.stringify(matches, null, 2) + "\n", "utf-8")

    const seasonSlugs = new Set<string>()
    for (const m of matches) {
      seasonSlugs.add(m.homeTeam.slug)
      seasonSlugs.add(m.awayTeam.slug)
      unionSlugs.add(m.homeTeam.slug)
      unionSlugs.add(m.awayTeam.slug)
    }

    const { first, last } = collectDates(matches)
    totalMatches += matches.length

    seasonEntries.push({
      season: spec.season,
      sourceUrl: spec.sourceUrl,
      rawFile: spec.rawFile,
      normalizedFile: spec.normalizedFile,
      sha256: sha256(rawBuffer),
      matches: matches.length,
      teams: seasonSlugs.size,
      firstMatchDate: first,
      lastMatchDate: last,
    })

    console.log(
      `✓ ${spec.season}: ${matches.length} matches, ${seasonSlugs.size} teams, ` +
        `${first} → ${last}, sha256 ${sha256(rawBuffer).slice(0, 12)}…`,
    )
  }

  const manifest = {
    schemaVersion: 1,
    competition: "Premier League",
    competitionSlug: HISTORY_COMPETITION_SLUG,
    source: "football-data.co.uk",
    seasons: seasonEntries,
    totals: {
      seasons: seasonEntries.length,
      matches: totalMatches,
      teams: unionSlugs.size,
    },
  }

  const manifestPath = join(HISTORY_DIR, "manifest.json")
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8")

  console.log(
    `\nhistory:import complete — ${seasonEntries.length} season(s), ` +
      `${totalMatches} matches, ${unionSlugs.size} distinct teams → ${manifestPath}`,
  )
}

main()
