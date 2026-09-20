/**
 * Reports how well the imported Premier League history (5 seasons) covers the
 * current 2026/27 Premier League teams from the static snapshot.
 *
 * Coverage grade per team (Phase III, §十一):
 *   strong  (≥4 seasons), medium (2-3), limited (1), none (0).
 *
 * Reads only local snapshot + history JSON. No network, no Supabase.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { HISTORY_SEASONS } from "../lib/football/history-seasons"
import type { HistoryMatch } from "../lib/football/history-normalize"

const DATA_DIR = join(process.cwd(), "data", "football")
const HISTORY_DIR = join(process.cwd(), "data", "history", "premier-league")

interface CompetitionRow {
  id: string
  slug: string
  name: string
}

interface TeamRow {
  id: string
  name: string
  slug: string
}

interface FixtureRow {
  competition_id: string
  home_team_id: string
  away_team_id: string
}

type Grade = "strong" | "medium" | "limited" | "none"

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T
}

function gradeFor(seasons: number): Grade {
  if (seasons >= 4) return "strong"
  if (seasons >= 2) return "medium"
  if (seasons === 1) return "limited"
  return "none"
}

function main(): void {
  const competitions = readJson<CompetitionRow[]>(join(DATA_DIR, "competitions.json"))
  const teams = readJson<TeamRow[]>(join(DATA_DIR, "teams.json"))
  const fixtures = readJson<FixtureRow[]>(join(DATA_DIR, "fixtures.json"))

  const pl = competitions.find((c) => c.slug === "premier-league")
  if (!pl) throw new Error("premier-league competition not found in snapshot")

  // Current 2026/27 PL team slugs from the snapshot fixtures.
  const currentTeamIds = new Set<string>()
  for (const f of fixtures) {
    if (f.competition_id === pl.id) {
      currentTeamIds.add(f.home_team_id)
      currentTeamIds.add(f.away_team_id)
    }
  }
  const teamById = new Map(teams.map((t) => [t.id, t]))
  const currentTeams = [...currentTeamIds]
    .map((id) => teamById.get(id))
    .filter((t): t is TeamRow => t != null)
    .sort((a, b) => a.slug.localeCompare(b.slug))

  // Historical seasons in which each current team's slug appears.
  const seasonsBySlug = new Map<string, Set<string>>()
  const matchesBySlug = new Map<string, number>()
  for (const spec of HISTORY_SEASONS) {
    const matches = readJson<HistoryMatch[]>(join(HISTORY_DIR, spec.normalizedFile))
    for (const m of matches) {
      for (const side of [m.homeTeam, m.awayTeam]) {
        if (!seasonsBySlug.has(side.slug)) seasonsBySlug.set(side.slug, new Set())
        seasonsBySlug.get(side.slug)!.add(spec.season)
        matchesBySlug.set(side.slug, (matchesBySlug.get(side.slug) ?? 0) + 1)
      }
    }
  }

  const seasonLabels = HISTORY_SEASONS.map((s) => s.season)

  console.log("Premier League history coverage — current 2026/27 teams vs. 5 imported seasons")
  console.log("=".repeat(96))
  console.log(
    `${"Team".padEnd(28)} ${"Seasons".padEnd(8)} ${"Matches".padEnd(8)} ${"Grade".padEnd(9)} Seasons present`,
  )
  console.log("-".repeat(96))

  const gradeCounts: Record<Grade, number> = { strong: 0, medium: 0, limited: 0, none: 0 }

  for (const team of currentTeams) {
    const seasons = seasonsBySlug.get(team.slug) ?? new Set<string>()
    const matches = matchesBySlug.get(team.slug) ?? 0
    const grade = gradeFor(seasons.size)
    gradeCounts[grade] += 1
    const present =
      seasons.size === 0 ? "—" : seasonLabels.filter((s) => seasons.has(s)).join(", ")
    console.log(
      `${team.slug.padEnd(28)} ${String(seasons.size).padEnd(8)} ${String(matches).padEnd(8)} ` +
        `${grade.padEnd(9)} ${present}`,
    )
  }

  console.log("=".repeat(96))
  console.log(
    `Coverage summary — strong (≥4): ${gradeCounts.strong}, medium (2-3): ${gradeCounts.medium}, ` +
      `limited (1): ${gradeCounts.limited}, none (0): ${gradeCounts.none}`,
  )
  console.log(
    `Total current PL teams: ${currentTeams.length} | historical seasons imported: ${HISTORY_SEASONS.length}`,
  )

  const noneTeams = currentTeams.filter((t) => gradeFor((seasonsBySlug.get(t.slug) ?? new Set()).size) === "none")
  if (noneTeams.length > 0) {
    console.log(`\nTeams with no historical coverage: ${noneTeams.map((t) => `${t.name} (${t.slug})`).join(", ")}`)
  }
}

main()
