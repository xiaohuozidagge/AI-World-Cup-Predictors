import { loadSyncedMatches, getSyncedDataAsOf } from "@/lib/synced-data"
import { matches } from "@/data/matches"
import { teams } from "@/data/teams"
import { sortMatchesByKickoff } from "@/lib/sortMatches"

export interface UpcomingMatch {
  matchSlug: string
  predictionSlug: string
  teamA: string
  teamB: string
  date: string
  utcDate?: string
  group?: string
  stage: string
  stadium: string
  city: string
  syncedStatus?: string
  actualScore?: { teamA: number; teamB: number } | null
}

// Match local match to synced data using team name AND slug comparison
function findSyncedForMatch(localTeamA: string, localTeamB: string) {
  const synced = loadSyncedMatches()
  const slugA = teams.find(t => t.name === localTeamA)?.slug
  const slugB = teams.find(t => t.name === localTeamB)?.slug
  return synced.find(s =>
    (s.teamA === localTeamA || s.teamASlug === localTeamA || (slugA && s.teamASlug === slugA)) &&
    (s.teamB === localTeamB || s.teamBSlug === localTeamB || (slugB && s.teamBSlug === slugB))
  )
}

export function getUpcomingMatches(now: number | string = getSyncedDataAsOf()): UpcomingMatch[] {
  const nowMs = typeof now === "number" ? now : new Date(now).getTime()

  const groupStage = matches.filter(m => m.stage === "Group Stage" && m.predictionSlug)

  const upcoming = groupStage
    .filter(m => {
      const sm = findSyncedForMatch(m.teamA, m.teamB)
      const status = sm?.status
      const kickoff = sm?.utcDate ? new Date(sm.utcDate).getTime() : new Date(m.date + "T23:59:59Z").getTime()
      return (!status || status === "scheduled") && kickoff > nowMs
    })
    .map(m => {
      const sm = findSyncedForMatch(m.teamA, m.teamB)
      return {
        matchSlug: m.slug,
        predictionSlug: m.predictionSlug!,
        teamA: m.teamA,
        teamB: m.teamB,
        date: m.date,
        utcDate: sm?.utcDate,
        group: m.group,
        stage: m.stage,
        stadium: m.stadium,
        city: m.city,
        syncedStatus: sm?.status,
        actualScore: sm?.actualScore || null,
      }
    })

  return sortMatchesByKickoff(upcoming)
}

export function getRecentFinishedMatches(limit = 10): UpcomingMatch[] {
  const groupStage = matches.filter(m => m.stage === "Group Stage" && m.predictionSlug)

  const finished = groupStage
    .map(m => {
      const sm = findSyncedForMatch(m.teamA, m.teamB)
      return {
        matchSlug: m.slug,
        predictionSlug: m.predictionSlug!,
        teamA: m.teamA,
        teamB: m.teamB,
        date: m.date,
        utcDate: sm?.utcDate,
        group: m.group,
        stage: m.stage,
        stadium: m.stadium,
        city: m.city,
        syncedStatus: sm?.status,
        actualScore: sm?.actualScore || null,
      }
    })
    .filter(m => m.syncedStatus === "finished")

  return sortMatchesByKickoff(finished).reverse().slice(0, limit)
}
