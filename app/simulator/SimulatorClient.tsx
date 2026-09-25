"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Brain, Shuffle, Zap, TrendingUp, Percent } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ProbabilityBar } from "@/components/ProbabilityBar"
import { teams, getTeamBySlug } from "@/data/teams"

// Deterministic hash from two team slugs — same input always produces same output.
// No Math.random() — every request to the same matchup returns identical predictions.
function hashTeams(a: string, b: string): number {
  const str = [a, b].sort().join("-")
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit int
  }
  return Math.abs(hash)
}

function deterministicVariant(hash: number, index: number, min: number, max: number): number {
  const v = ((hash * (index + 1) * 2654435761) >>> 0) % (max - min + 1)
  return min + v
}

function generateMockPrediction(teamA: string, teamB: string, rankingA: number, rankingB: number) {
  const h = hashTeams(teamA, teamB)
  const rankingDiff = rankingB - rankingA
  const baseAProb = 50 + (rankingDiff > 0 ? Math.min(rankingDiff * 2, 35) : Math.max(rankingDiff * 2, -35))
  const jitter = deterministicVariant(h, 0, -5, 5)
  const aProb = Math.round(Math.max(10, Math.min(80, baseAProb + jitter)))
  const maxDraw = Math.max(10, Math.min(30, 30 - Math.abs(rankingDiff)))
  const drawProb = Math.round(10 + (deterministicVariant(h, 1, 0, maxDraw - 10)))
  const bProb = 100 - aProb - drawProb

  const scoreGen = () => {
    const s1 = deterministicVariant(h, 2, 0, 3)
    const s2 = deterministicVariant(h, 3, 0, 3)
    if (aProb > 55) return `${Math.max(s1, 2)}-${Math.min(s2, 1)}`
    if (bProb > 55) return `${Math.min(s1, 1)}-${Math.max(s2, 2)}`
    return `${Math.max(s1, 1)}-${Math.max(s2, 1)}`
  }

  return {
    teamAWinProbability: aProb,
    drawProbability: drawProb,
    teamBWinProbability: bProb,
    predictedScore: scoreGen(),
    analysis: generateAnalysis(teamA, teamB, aProb, rankingA, rankingB),
  }
}

function generateAnalysis(teamA: string, teamB: string, aProb: number, rankingA: number, rankingB: number) {
  if (aProb > 60) {
    return `${teamA} enters this hypothetical matchup as the clear favorite. With a superior FIFA ranking (#${rankingA} vs #${rankingB}) and stronger recent form, ${teamA} should control possession and create more scoring opportunities. ${teamB} will need a disciplined defensive performance and clinical finishing on the counter-attack to pull off an upset.`
  } else if (aProb > 45) {
    return `This is projected to be a closely contested matchup between two quality sides. ${teamA} holds a slight edge (FIFA #${rankingA} vs #${rankingB}), but the margins are thin. The match could easily be decided by a set piece, individual moment of brilliance, or a defensive error. Expect a tactical battle.`
  } else {
    return `${teamB} is favored in this matchup, leveraging their higher FIFA ranking (#${rankingB} vs #${rankingA}) and stronger squad depth. ${teamA} will need to be at their absolute best defensively and capitalize on whatever chances come their way. The first goal could be decisive in shaping the match's tempo.`
  }
}

export function SimulatorClient() {
  const searchParams = useSearchParams()
  const teamASlug = searchParams.get("teamA") ?? ""
  const teamBSlug = searchParams.get("teamB") ?? ""

  const teamA = teamASlug ? getTeamBySlug(teamASlug) : undefined
  const teamB = teamBSlug ? getTeamBySlug(teamBSlug) : undefined

  const prediction = teamA && teamB
    ? generateMockPrediction(teamA.name, teamB.name, teamA.fifaRanking, teamB.fifaRanking)
    : null

  return (
    <div className="container mx-auto max-w-7xl px-4 py-12">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 bg-sports-green/10 text-sports-green rounded-full px-4 py-1.5 text-sm font-medium mb-4">
            <Zap className="h-4 w-4" /> Interactive Tool
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight mb-3">Match Simulator</h1>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto">
            Select any two teams and simulate the match. Our AI model generates instant win probability, predicted score, and analysis.
          </p>
        </div>

        {/* Simulator Form */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-sports-green" />
              Simulate a Match
            </CardTitle>
            <CardDescription>Choose two teams and click Predict to run the simulation.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action="/simulator" method="GET" className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <label htmlFor="teamA" className="block text-sm font-medium mb-2">Team A</label>
                  <select
                    id="teamA"
                    name="teamA"
                    defaultValue={teamASlug || "argentina"}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {teams.map((t) => (
                      <option key={t.slug} value={t.slug}>{t.flag} {t.name} (#{t.fifaRanking})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="teamB" className="block text-sm font-medium mb-2">Team B</label>
                  <select
                    id="teamB"
                    name="teamB"
                    defaultValue={teamBSlug || "brazil"}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {teams.map((t) => (
                      <option key={t.slug} value={t.slug}>{t.flag} {t.name} (#{t.fifaRanking})</option>
                    ))}
                  </select>
                </div>
              </div>
              <Button type="submit" size="xl" className="w-full bg-sports-green hover:bg-sports-green/90">
                <Shuffle className="h-4 w-4 mr-2" />
                Predict Match
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Results */}
        {prediction && teamA && teamB && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Matchup Header */}
            <Card className="border-sports-green/30 bg-gradient-to-r from-sports-green/5 to-sports-blue/5">
              <CardContent className="p-8">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 text-center">
                    <div className="text-5xl mb-3">{teamA.flag}</div>
                    <div className="font-bold text-xl">{teamA.name}</div>
                    <Badge variant="secondary" className="mt-1">#{teamA.fifaRanking} FIFA</Badge>
                  </div>
                  <div className="text-center">
                    <div className="text-4xl font-extrabold text-sports-green mb-2">{prediction.predictedScore}</div>
                    <div className="text-sm text-muted-foreground">Predicted Score</div>
                  </div>
                  <div className="flex-1 text-center">
                    <div className="text-5xl mb-3">{teamB.flag}</div>
                    <div className="font-bold text-xl">{teamB.name}</div>
                    <Badge variant="secondary" className="mt-1">#{teamB.fifaRanking} FIFA</Badge>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Win Probability */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Percent className="h-5 w-5 text-sports-green" />
                  Win Probability
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ProbabilityBar
                  a={prediction.teamAWinProbability}
                  draw={prediction.drawProbability}
                  b={prediction.teamBWinProbability}
                  size="lg"
                />
              </CardContent>
            </Card>

            {/* Analysis */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-sports-blue" />
                  AI Analysis
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed text-muted-foreground">{prediction.analysis}</p>
              </CardContent>
            </Card>

            {/* Quick Links */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {teamA && (
                <Link href={`/team/${teamA.slug}`}>
                  <Card className="hover:shadow-md hover:border-sports-blue/50 transition-all cursor-pointer">
                    <CardContent className="p-4 flex items-center gap-3">
                      <span className="text-2xl">{teamA.flag}</span>
                      <div>
                        <div className="font-semibold text-sm">{teamA.name} Team Profile</div>
                        <div className="text-xs text-muted-foreground">View key players, form, and predictions</div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              )}
              {teamB && (
                <Link href={`/team/${teamB.slug}`}>
                  <Card className="hover:shadow-md hover:border-sports-blue/50 transition-all cursor-pointer">
                    <CardContent className="p-4 flex items-center gap-3">
                      <span className="text-2xl">{teamB.flag}</span>
                      <div>
                        <div className="font-semibold text-sm">{teamB.name} Team Profile</div>
                        <div className="text-xs text-muted-foreground">View key players, form, and predictions</div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
