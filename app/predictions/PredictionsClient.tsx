"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Search, Calendar, Clock, EyeOff, ChevronRight } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ProbabilityBar } from "@/components/ProbabilityBar"
import { matches } from "@/data/matches"
import { predictions } from "@/data/predictions"
import { teams } from "@/data/teams"
import { generatePrediction } from "@/lib/prediction-engine"
import { loadSyncedMatches } from "@/lib/synced-data"
import { sortMatchesByKickoff, uniqueMatchDates } from "@/lib/sortMatches"
import { getCountdown } from "@/lib/getCountdown"
import { getPredictionAccuracy, accuracyEmoji } from "@/lib/predictionAccuracy"
import { getUpcomingMatches, getRecentFinishedMatches } from "@/lib/getUpcomingMatches"

const GROUPS = ["A","B","C","D","E","F","G","H","I","J","K","L"]

/**
 * The shape a rendered match row needs. The three producers (filtered search
 * results, upcoming matches, recent results) all map onto this one model, so a
 * single typed component covers every rendering path instead of `any`.
 */
interface MatchRowModel {
  slug: string
  predictionSlug?: string
  teamA: string
  teamB: string
  date: string
  group?: string
  stage: string
  stadium?: string
  city?: string
  synced?: {
    status?: string
    utcDate?: string
    actualScore?: { teamA: number; teamB: number } | null
  }
}

export function PredictionsClient({ referenceTime }: { referenceTime: string }) {
  const searchParams = useSearchParams()
  const searchTerm = (searchParams.get("search") ?? "").toLowerCase()
  const groupFilter = searchParams.get("group") ?? ""
  const dateFilter = searchParams.get("date") ?? ""
  const hideCompleted = searchParams.get("hide") === "1"
  const isFiltered = !!(searchTerm || groupFilter || dateFilter || hideCompleted)

  // The single fixed "now" the whole page classifies against. It comes from the
  // static archive snapshot (server) so the first screen is byte-stable, never
  // from the browser clock.
  const referenceTimeMs = new Date(referenceTime).getTime()

  const synced = loadSyncedMatches()
  const upcoming = getUpcomingMatches(referenceTimeMs)
  const recentFinished = getRecentFinishedMatches(10)
  const nextPredictionSlug = upcoming[0]?.predictionSlug

  // Build filtered view for search/filter mode
  const groupStageMatches = matches.filter(m => m.stage === "Group Stage" && m.predictionSlug)
  const enriched = groupStageMatches.map(m => {
    const sm = synced.find(s =>
      (s.teamA === m.teamA || s.teamASlug === m.teamA) &&
      (s.teamB === m.teamB || s.teamBSlug === m.teamB)
    )
    return { ...m, synced: sm }
  })

  let filtered = enriched
  if (searchTerm) filtered = filtered.filter(m => m.teamA.toLowerCase().includes(searchTerm) || m.teamB.toLowerCase().includes(searchTerm) || m.group?.toLowerCase().includes(searchTerm))
  if (groupFilter) filtered = filtered.filter(m => m.group === groupFilter)
  if (hideCompleted) filtered = filtered.filter(m => m.synced?.status !== "finished")
  if (dateFilter) filtered = filtered.filter(m => m.date === dateFilter)

  const filteredSorted = sortMatchesByKickoff(filtered.map(m => ({ ...m, utcDate: m.synced?.utcDate })))

  // Date tabs
  const allDates = uniqueMatchDates(enriched)

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight mb-2">Match Predictions</h1>
        <p className="text-muted-foreground">World Cup 2026 watch calendar — live scores, kickoff times, and AI predictions.</p>
      </div>

      {/* Filters bar */}
      <div className="flex flex-col gap-3 mb-6">
        <div className="flex flex-col sm:flex-row gap-3">
          <form className="flex gap-3 flex-1" method="GET">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input name="search" placeholder="Search team..." className="pl-9" defaultValue={searchTerm} />
            </div>
            <select name="group" defaultValue={groupFilter} className="rounded-md border border-input bg-background px-3 py-1 text-sm">
              <option value="">All Groups</option>
              {GROUPS.map(g => <option key={g} value={g}>Group {g}</option>)}
            </select>
            <Button type="submit" variant="outline" size="sm">Filter</Button>
            {hideCompleted && <input type="hidden" name="hide" value="1" />}
            {dateFilter && <input type="hidden" name="date" value={dateFilter} />}
          </form>
          <form method="GET">
            {searchTerm && <input type="hidden" name="search" value={searchTerm} />}
            {groupFilter && <input type="hidden" name="group" value={groupFilter} />}
            {dateFilter && <input type="hidden" name="date" value={dateFilter} />}
            <Button type="submit" name="hide" value={hideCompleted ? "0" : "1"} variant={hideCompleted ? "default" : "outline"} size="sm">
              <EyeOff className="h-4 w-4 mr-1" />{hideCompleted ? "Showing All" : "Hide Completed"}
            </Button>
          </form>
        </div>
        <DateTabs allDates={allDates} referenceTime={referenceTime} dateFilter={dateFilter} hideCompleted={hideCompleted} />
        {isFiltered && (
          <a href="/predictions" className="text-xs text-sports-green hover:underline">Clear all filters</a>
        )}
      </div>

      {/* Display */}
      {isFiltered ? (
        <div className="space-y-3">
          {filteredSorted.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Calendar className="h-12 w-12 mx-auto mb-4 opacity-30" />
              <p className="text-lg">No matches found.</p>
            </div>
          ) : (
            filteredSorted.map(m => <MatchRow key={m.slug} m={m} isNext={m.predictionSlug === nextPredictionSlug} referenceTime={referenceTime} />)
          )}
        </div>
      ) : (
        <>
          {/* Upcoming section */}
          <div className="mb-10">
            <h2 className="text-xl font-bold mb-1">Upcoming Matches</h2>
            <p className="text-sm text-muted-foreground mb-4">{upcoming.length} scheduled matches</p>
            <div className="space-y-2">
              {upcoming.length === 0 && <p className="text-muted-foreground text-sm py-4">All group stage matches have been completed.</p>}
              {upcoming.map(m => (
                <MatchRow
                  key={m.predictionSlug}
                  m={{
                    slug: m.matchSlug, predictionSlug: m.predictionSlug,
                    teamA: m.teamA, teamB: m.teamB, date: m.date, group: m.group, stage: m.stage,
                    synced: { status: m.syncedStatus, utcDate: m.utcDate, actualScore: undefined },
                  }}
                  isNext={m.predictionSlug === nextPredictionSlug}
                  referenceTime={referenceTime}
                />
              ))}
            </div>
          </div>

          {/* Recent Results */}
          {recentFinished.length > 0 && (
            <div>
              <h2 className="text-xl font-bold mb-1">Recent Results</h2>
              <p className="text-sm text-muted-foreground mb-4">{recentFinished.length} completed matches</p>
              <div className="space-y-2 opacity-80">
                {recentFinished.map(m => (
                  <MatchRow
                    key={m.predictionSlug}
                    m={{
                      slug: m.matchSlug, predictionSlug: m.predictionSlug,
                      teamA: m.teamA, teamB: m.teamB, date: m.date, group: m.group, stage: m.stage,
                      synced: { status: "finished", utcDate: m.utcDate, actualScore: m.actualScore },
                    }}
                    isNext={false}
                    referenceTime={referenceTime}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function MatchRow({ m, isNext, referenceTime }: { m: MatchRowModel; isNext: boolean; referenceTime: string }) {
  const pred = predictions.find(p => p.matchSlug === m.predictionSlug)
  const teamA = teams.find(t => t.name === m.teamA)
  const teamB = teams.find(t => t.name === m.teamB)
  const fallback = (!pred && teamA && teamB)
    ? generatePrediction(m.teamA, m.teamB, teamA.fifaRanking, teamB.fifaRanking, m.stage, m.group || "", m.date, m.stadium || "", m.city || "", teamA.keyPlayers, teamB.keyPlayers)
    : null
  const resolvedPred = pred || fallback
  const isFinished = m.synced?.status === "finished"
  const isLive = m.synced?.status === "live"
  const actualScore = m.synced?.actualScore
  const accuracy = isFinished && actualScore && resolvedPred
    ? getPredictionAccuracy(resolvedPred.predictedScore, actualScore)
    : null
  const utcDate = m.synced?.utcDate
  const countdown = utcDate && !isFinished ? getCountdown(utcDate, referenceTime) : null
  const timeDisplay = utcDate
    ? new Date(utcDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC", hour12: true }) + " UTC"
    : null
  const dateDisplay = new Date(m.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })

  return (
    <Link href={`/match/${m.predictionSlug}`}>
      <Card className={`group hover:shadow-md transition-all duration-200 cursor-pointer ${isNext ? "border-sports-green ring-1 ring-sports-green/30" : "hover:border-sports-green/50"} ${isLive ? "border-red-400/50 bg-red-50/30" : ""} ${isFinished ? "opacity-75" : ""}`}>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-center gap-3 sm:w-44 flex-shrink-0">
              {isLive && <Badge className="bg-red-500 text-white text-[10px] animate-pulse">LIVE</Badge>}
              {isFinished && <Badge variant="secondary" className="text-[10px]">FT</Badge>}
              {!isFinished && !isLive && isNext && <Badge className="bg-sports-green text-white text-[10px]">⭐ NEXT</Badge>}
              {!isFinished && !isLive && !isNext && <Badge variant="outline" className="text-[10px]">Upcoming</Badge>}
            </div>

            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-1 justify-end min-w-0">
                <span className="font-semibold text-sm truncate">{m.teamA}</span>
                <span className="text-lg flex-shrink-0">{teamA?.flag || "⚽"}</span>
              </div>
              <div className="text-center flex-shrink-0 min-w-[60px]">
                {isFinished && actualScore ? (
                  <><div className="text-lg font-extrabold">{actualScore.teamA}-{actualScore.teamB}</div><div className="text-[10px] text-muted-foreground">Final</div></>
                ) : isLive && actualScore ? (
                  <><div className="text-lg font-extrabold text-red-500">{actualScore.teamA}-{actualScore.teamB}</div><div className="text-[10px] text-red-500 font-medium">LIVE</div></>
                ) : (
                  <><div className="text-lg font-extrabold text-sports-green">{resolvedPred?.predictedScore || "?-?"}</div><div className="text-[10px] text-muted-foreground">Predicted</div></>
                )}
              </div>
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="text-lg flex-shrink-0">{teamB?.flag || "⚽"}</span>
                <span className="font-semibold text-sm truncate">{m.teamB}</span>
              </div>
            </div>

            <div className="flex items-center gap-4 sm:w-56 flex-shrink-0 justify-end text-xs text-muted-foreground">
              <div className="text-right leading-tight">
                <div className="flex items-center gap-1 justify-end"><Calendar className="h-3 w-3" /><span>{dateDisplay}</span></div>
                {timeDisplay && <div className="flex items-center gap-1 justify-end"><Clock className="h-3 w-3" /><span>{timeDisplay}</span></div>}
                {countdown && !isFinished && <div className="text-sports-green font-medium">{countdown}</div>}
                {accuracy && <div>{accuracyEmoji(accuracy)} {accuracy}</div>}
              </div>
              <div className="text-center"><Badge variant="secondary" className="text-[10px]">G{m.group}</Badge></div>
              <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-sports-green transition-colors flex-shrink-0" />
            </div>
          </div>
          {!isFinished && resolvedPred && (
            <div className="mt-2 pt-2 border-t border-muted/50">
              <ProbabilityBar a={resolvedPred.teamAWinProbability} draw={resolvedPred.drawProbability} b={resolvedPred.teamBWinProbability} size="sm" />
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  )
}

function DateTabs({ allDates, referenceTime, dateFilter, hideCompleted }: {
  allDates: string[]; referenceTime: string; dateFilter: string; hideCompleted: boolean
}) {
  const nowMs = new Date(referenceTime).getTime()
  const today = new Date(nowMs).toISOString().split("T")[0]
  const tomorrowDate = new Date(nowMs + 86400000).toISOString().split("T")[0]
  const todayLabel = new Date(nowMs).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
  const tomorrowLabel = new Date(nowMs + 86400000).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })

  return (
    <div className="flex flex-wrap gap-1.5">
      <DateTab href={`?${hideCompleted ? "hide=1" : ""}`} label="All" active={!dateFilter} />
      {allDates.includes(today) && <DateTab href={`?date=${today}${hideCompleted ? "&hide=1" : ""}`} label={`Today · ${todayLabel}`} active={dateFilter === today} />}
      {allDates.includes(tomorrowDate) && <DateTab href={`?date=${tomorrowDate}${hideCompleted ? "&hide=1" : ""}`} label={`Tomorrow · ${tomorrowLabel}`} active={dateFilter === tomorrowDate} />}
      {allDates.filter(d => d !== today && d !== tomorrowDate).map(d => {
        const label = new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
        return <DateTab key={d} href={`?date=${d}${hideCompleted ? "&hide=1" : ""}`} label={label} active={dateFilter === d} />
      })}
    </div>
  )
}

function DateTab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <a href={href}>
      <Badge variant={active ? "default" : "outline"} className={`cursor-pointer whitespace-nowrap text-xs ${active ? "bg-sports-green hover:bg-sports-green/90" : ""}`}>
        {label}
      </Badge>
    </a>
  )
}
