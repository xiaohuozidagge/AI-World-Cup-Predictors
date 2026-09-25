import syncedMatchesRaw from "@/data/synced/matches.json"
import type { SyncedMatch } from "@/lib/football-data/normalize"
import { teams } from "@/data/teams"

let _syncedMatches: SyncedMatch[] | null = null

/**
 * The archived World Cup 2026 match results, inlined as a static JSON import.
 * There is no filesystem access and no runtime fetch — the archive is fixed, so
 * it is bundled at build time and usable from both server and client components.
 */
export function loadSyncedMatches(): SyncedMatch[] {
  if (_syncedMatches !== null) return _syncedMatches
  _syncedMatches = syncedMatchesRaw as unknown as SyncedMatch[]
  return _syncedMatches
}

/**
 * The fixed "as of" timestamp for the World Cup 2026 archive: the latest
 * `sourceUpdatedAt` across all synced matches. It is derived from the bundled
 * static snapshot, never from `new Date()`/`Date.now()`, so the predictions and
 * team pages classify every match deterministically across builds.
 */
export function getSyncedDataAsOf(): string {
  const synced = loadSyncedMatches()
  let asOf = "1970-01-01T00:00:00Z"
  for (const m of synced) {
    if (m.sourceUpdatedAt > asOf) asOf = m.sourceUpdatedAt
  }
  return asOf
}

function teamMatch(syncedTeam: string, syncedSlug: string | undefined, localTeam: string): boolean {
  if (syncedTeam === localTeam) return true
  if (syncedSlug === localTeam) return true
  const localSlug = teams.find(t => t.name === localTeam)?.slug
  if (localSlug && syncedSlug === localSlug) return true
  return false
}

export function findSyncedMatch(teamA: string, teamB: string): SyncedMatch | undefined {
  const synced = loadSyncedMatches()
  return synced.find(m => teamMatch(m.teamA, m.teamASlug, teamA) && teamMatch(m.teamB, m.teamBSlug, teamB))
}

export function findSyncedMatchBySlug(slug: string): SyncedMatch | undefined {
  const synced = loadSyncedMatches()
  return synced.find(m => m.slug === slug)
}

export function isMatchFinished(synced?: SyncedMatch): boolean {
  return synced?.status === "finished" && !!synced.actualScore
}

export function lookupUtcDate(teamA: string, teamB: string): string | undefined {
  const m = findSyncedMatch(teamA, teamB)
  return m?.utcDate
}
