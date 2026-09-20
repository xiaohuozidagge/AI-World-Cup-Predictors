/**
 * Verifies the imported Premier League history under
 * `data/history/premier-league/` against the raw CSVs and the source manifest.
 *
 * Checks, per season and across the whole set:
 *  - 380 matches and 20 teams per season
 *  - 38 matches per team: 19 home + 19 away
 *  - each team plays every other team exactly once home and once away
 *  - unique match IDs
 *  - valid calendar dates and non-negative scores
 *  - full-time / half-time result letters consistent with the score
 *  - home ≠ away, non-empty slugs/canonical/source names
 *  - manifest counts, dates, and SHA-256 match the raw CSV
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { HISTORY_SEASONS } from "../lib/football/history-seasons"
import {
  resultFromScore,
  type HistoryMatch,
  type TeamAliases,
} from "../lib/football/history-normalize"

const HISTORY_DIR = join(process.cwd(), "data", "history", "premier-league")
const RAW_DIR = join(HISTORY_DIR, "raw")
const NORMALIZED_DIR = join(HISTORY_DIR, "normalized")

const EXPECTED_MATCHES_PER_SEASON = 380
const EXPECTED_TEAMS_PER_SEASON = 20

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

let checks = 0
const errors: string[] = []

function ok(message: string): void {
  checks += 1
  console.log(`✓ ${message}`)
}

function fail(message: string): void {
  errors.push(message)
  console.error(`✗ ${message}`)
}

function assert(condition: boolean, message: string): void {
  if (condition) ok(message)
  else fail(message)
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex")
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function isValidIsoDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12) return false
  const max = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]
  return day >= 1 && day <= max
}

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0
}

function verifyScoreConsistency(match: HistoryMatch, label: string): void {
  const ft = match.fullTime
  assert(isNonNegativeInt(ft.home) && isNonNegativeInt(ft.away), `${label} full-time score non-negative`)
  assert(
    ft.result === resultFromScore(ft.home, ft.away),
    `${label} full-time result "${ft.result}" matches ${ft.home}-${ft.away}`,
  )
  if (match.halfTime) {
    const ht = match.halfTime
    assert(isNonNegativeInt(ht.home) && isNonNegativeInt(ht.away), `${label} half-time score non-negative`)
    assert(
      ht.result === resultFromScore(ht.home, ht.away),
      `${label} half-time result "${ht.result}" matches ${ht.home}-${ht.away}`,
    )
  }
}

function verifyTeamStructure(match: HistoryMatch, label: string): void {
  assert(match.homeTeam.slug !== "", `${label} home slug non-empty`)
  assert(match.awayTeam.slug !== "", `${label} away slug non-empty`)
  assert(match.homeTeam.canonicalName !== "", `${label} home canonical name non-empty`)
  assert(match.awayTeam.canonicalName !== "", `${label} away canonical name non-empty`)
  assert(match.homeTeam.sourceName !== "", `${label} home source name non-empty`)
  assert(match.awayTeam.sourceName !== "", `${label} away source name non-empty`)
  assert(match.homeTeam.slug !== match.awayTeam.slug, `${label} home ≠ away`)
  assert(match.date !== "", `${label} date non-empty`)
  assert(isValidIsoDate(match.date), `${label} date valid`)
}

interface SeasonEntry {
  season: string
  sha256: string
  matches: number
  teams: number
  firstMatchDate: string
  lastMatchDate: string
}

interface Manifest {
  schemaVersion: number
  competitionSlug: string
  source: string
  seasons: SeasonEntry[]
  totals: { seasons: number; matches: number; teams: number }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T
}

function verifySeason(spec: (typeof HISTORY_SEASONS)[number], manifest: Manifest, aliases: TeamAliases): void {
  const normalizedPath = join(NORMALIZED_DIR, `${spec.season}.json`)
  const rawPath = join(RAW_DIR, `${spec.season}.csv`)
  assert(existsSync(normalizedPath), `${spec.season}: normalized JSON exists`)
  assert(existsSync(rawPath), `${spec.season}: raw CSV exists`)
  if (!existsSync(normalizedPath) || !existsSync(rawPath)) return

  const matches = readJson<HistoryMatch[]>(normalizedPath)
  const rawBuffer = readFileSync(rawPath)

  // Raw CSV SHA-256 matches the manifest.
  const manifestEntry = manifest.seasons.find((s) => s.season === spec.season)
  assert(manifestEntry != null, `${spec.season}: present in manifest`)
  if (manifestEntry) {
    assert(manifestEntry.sha256 === sha256(rawBuffer), `${spec.season}: SHA-256 matches raw CSV`)
    assert(manifestEntry.matches === matches.length, `${spec.season}: manifest matches count (${matches.length})`)
  }

  // Counts.
  assert(matches.length === EXPECTED_MATCHES_PER_SEASON, `${spec.season}: 380 matches`)

  // Unique IDs.
  const ids = new Set(matches.map((m) => m.id))
  assert(ids.size === matches.length, `${spec.season}: all match IDs unique`)

  // Per-team home/away balance and round-robin completeness.
  const teamSlugs = new Set<string>()
  for (const m of matches) {
    teamSlugs.add(m.homeTeam.slug)
    teamSlugs.add(m.awayTeam.slug)
  }
  assert(teamSlugs.size === EXPECTED_TEAMS_PER_SEASON, `${spec.season}: 20 distinct teams`)

  const homeOpponents = new Map<string, Set<string>>()
  const awayOpponents = new Map<string, Set<string>>()
  const homeCount = new Map<string, number>()
  const awayCount = new Map<string, number>()
  for (const slug of teamSlugs) {
    homeOpponents.set(slug, new Set())
    awayOpponents.set(slug, new Set())
    homeCount.set(slug, 0)
    awayCount.set(slug, 0)
  }

  let structureOk = true
  for (const m of matches) {
    const label = `${spec.season} ${m.id}`
    verifyTeamStructure(m, label)
    verifyScoreConsistency(m, label)
    if (!m.homeTeam.slug || !m.awayTeam.slug || m.homeTeam.slug === m.awayTeam.slug) structureOk = false
    if (structureOk) {
      homeOpponents.get(m.homeTeam.slug)?.add(m.awayTeam.slug)
      awayOpponents.get(m.awayTeam.slug)?.add(m.homeTeam.slug)
      homeCount.set(m.homeTeam.slug, (homeCount.get(m.homeTeam.slug) ?? 0) + 1)
      awayCount.set(m.awayTeam.slug, (awayCount.get(m.awayTeam.slug) ?? 0) + 1)
    }
  }

  for (const slug of teamSlugs) {
    const home = homeCount.get(slug) ?? 0
    const away = awayCount.get(slug) ?? 0
    assert(home === 19, `${spec.season} ${slug}: 19 home matches (${home})`)
    assert(away === 19, `${spec.season} ${slug}: 19 away matches (${away})`)
    assert(home + away === 38, `${spec.season} ${slug}: 38 total matches (${home + away})`)

    const expected = new Set([...teamSlugs].filter((t) => t !== slug))
    const homeSet = homeOpponents.get(slug) ?? new Set()
    const awaySet = awayOpponents.get(slug) ?? new Set()
    assert(
      homeSet.size === 19 && [...homeSet].every((t) => expected.has(t)),
      `${spec.season} ${slug}: 19 distinct home opponents`,
    )
    assert(
      awaySet.size === 19 && [...awaySet].every((t) => expected.has(t)),
      `${spec.season} ${slug}: 19 distinct away opponents`,
    )
    assert(
      homeSet.size === awaySet.size && [...homeSet].every((t) => awaySet.has(t)),
      `${spec.season} ${slug}: home/away opponents match`,
    )
  }

  // Dates: monotonic within the season and match the manifest.
  const dates = matches.map((m) => m.date)
  const sorted = [...dates].sort()
  assert(
    dates.every((d, i) => d === sorted[i]),
    `${spec.season}: matches ordered by date`,
  )
  if (manifestEntry) {
    assert(manifestEntry.firstMatchDate === dates[0], `${spec.season}: manifest firstMatchDate`)
    assert(manifestEntry.lastMatchDate === dates[dates.length - 1], `${spec.season}: manifest lastMatchDate`)
  }
}

function main(): void {
  const manifestPath = join(HISTORY_DIR, "manifest.json")
  assert(existsSync(manifestPath), "manifest.json exists")
  if (!existsSync(manifestPath)) {
    console.error(`\nhistory:verify failed with ${errors.length} error(s).`)
    process.exitCode = 1
    return
  }

  const manifest = readJson<Manifest>(manifestPath)
  const aliases = readJson<TeamAliases>(join(HISTORY_DIR, "team-aliases.json"))

  assert(manifest.schemaVersion === 1, "manifest schemaVersion is 1")
  assert(manifest.source === "football-data.co.uk", "manifest source is football-data.co.uk")
  assert(manifest.competitionSlug === "premier-league", "manifest competitionSlug is premier-league")
  assert(manifest.seasons.length === HISTORY_SEASONS.length, `manifest lists ${HISTORY_SEASONS.length} seasons`)

  for (const spec of HISTORY_SEASONS) {
    verifySeason(spec, manifest, aliases)
  }

  // Totals.
  assert(
    manifest.totals.matches === HISTORY_SEASONS.length * EXPECTED_MATCHES_PER_SEASON,
    `manifest totals.matches (${manifest.totals.matches})`,
  )
  assert(manifest.totals.seasons === HISTORY_SEASONS.length, `manifest totals.seasons (${manifest.totals.seasons})`)

  // Every source name across all normalized data is aliased (belt-and-braces).
  const unaliased = new Set<string>()
  for (const spec of HISTORY_SEASONS) {
    const matches = readJson<HistoryMatch[]>(join(NORMALIZED_DIR, `${spec.season}.json`))
    for (const m of matches) {
      if (!aliases[m.homeTeam.sourceName]) unaliased.add(m.homeTeam.sourceName)
      if (!aliases[m.awayTeam.sourceName]) unaliased.add(m.awayTeam.sourceName)
    }
  }
  assert(unaliased.size === 0, `all source team names aliased (${unaliased.size} unaliased)`)

  console.log(`\nhistory:verify complete — ${checks} check(s), ${errors.length} error(s).`)

  if (errors.length > 0) {
    console.error("FAILED.")
    process.exitCode = 1
  } else {
    console.log("PASSED.")
  }
}

main()
