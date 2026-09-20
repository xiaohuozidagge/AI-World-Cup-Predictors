/**
 * Pure normalization for football-data.co.uk Premier League history: stable
 * match IDs, team-name aliasing, and the normalized match shape. No I/O, no
 * runtime clock, no Date — everything is a pure function of its inputs.
 */

import { extractE0Row, parseDmyDate, parseLocalTime, type E0HeaderMap } from "./history-csv"

export const HISTORY_COMPETITION_SLUG = "premier-league"

/** Short competition code used inside history match IDs (matches the current PL slug style). */
const HISTORY_ID_COMPETITION_CODE = "pl"

export interface HistoryTeamRef {
  sourceName: string
  canonicalName: string
  slug: string
}

export type HistoryResult = "H" | "D" | "A"

export interface HistoryScore {
  home: number
  away: number
  result: HistoryResult
}

export interface HistoryMatch {
  id: string
  competition: "premier-league"
  season: string
  date: string
  kickoffTimeLocal: string | null
  homeTeam: HistoryTeamRef
  awayTeam: HistoryTeamRef
  fullTime: HistoryScore
  halfTime: HistoryScore | null
}

export interface HistoryAlias {
  canonicalName: string
  slug: string
}

/** Source team name → canonical name + slug. */
export type TeamAliases = Record<string, HistoryAlias>

/** Derive the full-time result letter from a score. */
export function resultFromScore(home: number, away: number): HistoryResult {
  if (home > away) return "H"
  if (home < away) return "A"
  return "D"
}

/** Build the deterministic match ID from competition, season, slugs and date. */
export function buildMatchId(season: string, homeSlug: string, awaySlug: string, date: string): string {
  return `${HISTORY_ID_COMPETITION_CODE}-${season}-${homeSlug}-vs-${awaySlug}-${date}`
}

/** Parse a non-negative integer score cell, returning null for a blank cell. */
export function parseScoreCell(value: string | null | undefined): number | null {
  if (value == null) return null
  const t = value.trim()
  if (t === "") return null
  if (!/^\d+$/.test(t)) throw new Error(`invalid score cell: "${value}"`)
  return Number(t)
}

/** Parse a result letter, returning null for a blank value. */
export function parseResultCell(value: string | null | undefined): HistoryResult | null {
  if (value == null) return null
  const t = value.trim().toUpperCase()
  if (t === "") return null
  if (t !== "H" && t !== "D" && t !== "A") throw new Error(`invalid result cell: "${value}"`)
  return t
}

/** Normalize one parsed row into a `HistoryMatch`; throws on any bad input. */
export function normalizeMatch(
  cells: string[],
  headerMap: E0HeaderMap,
  season: string,
  aliases: TeamAliases,
): HistoryMatch {
  const row = extractE0Row(cells, headerMap)

  const date = parseDmyDate(row.date)
  const kickoffTimeLocal = parseLocalTime(row.time ?? "")

  const homeSource = row.homeTeam
  const awaySource = row.awayTeam
  if (homeSource === "" || awaySource === "") {
    throw new Error(`match with blank team name (${season})`)
  }

  const homeAlias = aliases[homeSource]
  const awayAlias = aliases[awaySource]
  if (!homeAlias || !awayAlias) {
    const unmapped = [homeAlias ? null : homeSource, awayAlias ? null : awaySource].filter(Boolean).join(", ")
    throw new Error(`unmapped team name(s): ${unmapped}`)
  }

  const fthg = parseScoreCell(row.fthg)
  const ftag = parseScoreCell(row.ftag)
  if (fthg == null || ftag == null) {
    throw new Error(`missing full-time score for ${homeSource} vs ${awaySource} (${season})`)
  }
  const result = resultFromScore(fthg, ftag)
  const rawResult = parseResultCell(row.ftr)
  if (rawResult != null && rawResult !== result) {
    throw new Error(
      `FTR mismatch for ${homeSource} vs ${awaySource} (${season}): score ${fthg}-${ftag} but FTR "${row.ftr}"`,
    )
  }

  const hthg = parseScoreCell(row.hthg)
  const htag = parseScoreCell(row.htag)
  let halfTime: HistoryScore | null = null
  if (hthg != null && htag != null) {
    const htResult = resultFromScore(hthg, htag)
    const rawHtResult = parseResultCell(row.htr)
    if (rawHtResult != null && rawHtResult !== htResult) {
      throw new Error(
        `HTR mismatch for ${homeSource} vs ${awaySource} (${season}): score ${hthg}-${htag} but HTR "${row.htr}"`,
      )
    }
    halfTime = { home: hthg, away: htag, result: htResult }
  }

  return {
    id: buildMatchId(season, homeAlias.slug, awayAlias.slug, date),
    competition: HISTORY_COMPETITION_SLUG,
    season,
    date,
    kickoffTimeLocal,
    homeTeam: { sourceName: homeSource, canonicalName: homeAlias.canonicalName, slug: homeAlias.slug },
    awayTeam: { sourceName: awaySource, canonicalName: awayAlias.canonicalName, slug: awayAlias.slug },
    fullTime: { home: fthg, away: ftag, result },
    halfTime,
  }
}

/** Deterministic ordering for a season's matches. */
function compareMatches(a: HistoryMatch, b: HistoryMatch): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  const aTime = a.kickoffTimeLocal ?? ""
  const bTime = b.kickoffTimeLocal ?? ""
  if (aTime !== bTime) return aTime < bTime ? -1 : 1
  if (a.homeTeam.slug !== b.homeTeam.slug) return a.homeTeam.slug < b.homeTeam.slug ? -1 : 1
  if (a.awayTeam.slug !== b.awayTeam.slug) return a.awayTeam.slug < b.awayTeam.slug ? -1 : 1
  return 0
}

/** Normalize a whole season's rows, deduplicate IDs, and sort deterministically. */
export function normalizeSeason(
  rows: string[][],
  headerMap: E0HeaderMap,
  season: string,
  aliases: TeamAliases,
): HistoryMatch[] {
  const matches: HistoryMatch[] = []
  const seenIds = new Set<string>()

  for (const row of rows) {
    const match = normalizeMatch(row, headerMap, season, aliases)
    if (seenIds.has(match.id)) {
      throw new Error(`duplicate match ID: ${match.id}`)
    }
    seenIds.add(match.id)
    matches.push(match)
  }

  matches.sort(compareMatches)
  return matches
}
