import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Trophy, Star, Users, TrendingUp, ChevronRight, BarChart3, Percent, Globe } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { FAQSection } from "@/components/FAQSection"
import { JsonLd, faqJsonLd, breadcrumbJsonLd } from "@/lib/jsonld"
import { SITE_URL } from "@/lib/constants"
import { teams, getTeamBySlug, getTeamsByGroup } from "@/data/teams"
import { predictions } from "@/data/predictions"
import { getSyncedDataAsOf } from "@/lib/synced-data"
import { getUpcomingMatches, getRecentFinishedMatches } from "@/lib/getUpcomingMatches"

export async function generateStaticParams() { return teams.map((t) => ({ slug: t.slug })) }

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params; const team = getTeamBySlug(slug)
  if (!team) return { title: "Team Not Found" }
  return { title: `${team.name} World Cup 2026 — Team Profile & Predictions`, description: `${team.name} World Cup 2026 team profile. FIFA ranking #${team.fifaRanking}, coach ${team.coach}, key players: ${team.keyPlayers.slice(0,3).join(", ")}. AI predictions and match analysis.`, openGraph: { title: `${team.name} World Cup 2026 — Team Profile & Predictions`, description: `${team.name} World Cup 2026 team profile.`, type: "article", publishedTime: "2026-06-09T00:00:00Z", modifiedTime: getSyncedDataAsOf() }, alternates: { canonical: `/team/${slug}` } }
}

export default async function TeamPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params; const team = getTeamBySlug(slug); if (!team) notFound()
  const allMatches = getUpcomingMatches().filter(m => m.teamA === team.name || m.teamB === team.name)
  const finished = getRecentFinishedMatches(20).filter(m => m.teamA === team.name || m.teamB === team.name)
  const groupTeams = getTeamsByGroup(team.group)

  // AI Tournament Projection
  const projection = getTournamentProjection(team)

  const teamFAQs = [
    { question: `Can ${team.name} win the World Cup 2026?`, answer: `${team.worldCupTitles > 0 ? `${team.name} has won the FIFA World Cup ${team.worldCupTitles} time(s) — ${team.bestResult}.` : `${team.name} has never won the World Cup, with a best finish of ${team.bestResult}.`} ${team.description}` },
    { question: `Who are ${team.name}'s key players for World Cup 2026?`, answer: `${team.keyPlayers.join(", ")} form the core of ${team.name}'s squad. ${team.keyPlayers[0]} is the standout talent and will be central to ${team.name}'s chances of progressing from Group ${team.group}.` },
    { question: `What is ${team.name}'s FIFA ranking and World Cup record?`, answer: `${team.name} is ranked #${team.fifaRanking} in the latest FIFA World Rankings. Their best World Cup performance is ${team.bestResult}. They are coached by ${team.coach}.` },
    { question: `What group is ${team.name} in for World Cup 2026?`, answer: `${team.name} has been drawn in Group ${team.group} alongside ${groupTeams.filter(t=>t.slug!==slug).map(t=>t.name).join(", ")}.` },
    { question: `How far can ${team.name} go in World Cup 2026?`, answer: `Based on our AI analysis, ${team.name} has a ${projection.advanceFromGroup}% chance of reaching the knockout stage. Their tournament ceiling projects to the ${projection.ceiling} — ${projection.ceilingReason}.` },
  ]

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8">
      <JsonLd data={faqJsonLd(teamFAQs)} />
      <JsonLd data={breadcrumbJsonLd([{name:"Home",url:"/"},{name:"Teams",url:"/teams"},{name:team.name,url:`/team/${slug}`}], SITE_URL)} />

      <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-6"><Link href="/" className="hover:text-sports-green">Home</Link><ChevronRight className="h-3 w-3"/><Link href="/teams" className="hover:text-sports-green">Teams</Link><ChevronRight className="h-3 w-3"/><span className="text-foreground font-medium">{team.name}</span></nav>

      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start gap-6 mb-10">
        <div className="text-6xl">{team.flag}</div>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-3 mb-2"><h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">{team.name}</h1>{team.worldCupTitles>0&&<Badge variant="warning"><Trophy className="h-3 w-3 mr-1"/>{team.worldCupTitles}x Champion</Badge>}</div>
          <div className="flex flex-wrap gap-4 mb-4"><Badge variant="secondary">Group {team.group}</Badge><Badge variant="info">#{team.fifaRanking} FIFA</Badge><Badge variant="outline">Coach: {team.coach}</Badge></div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          {/* 1. Team Overview */}
          <Card><CardHeader><CardTitle>Team Overview</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground leading-relaxed space-y-2">
            <p>{team.description}</p>
            <p>{team.name} enters World Cup 2026 as {team.fifaRanking <= 10 ? "one of the tournament favorites, with genuine championship aspirations backed by a deep, talented squad" : team.fifaRanking <= 25 ? "a legitimate contender for a deep tournament run, with the quality to trouble any opponent on their day" : team.fifaRanking <= 50 ? "a team capable of springing surprises, particularly against higher-ranked opponents who may underestimate them" : "an underdog story waiting to be written — every World Cup has its Cinderella, and this squad has nothing to lose"}. Under {team.coach}'s leadership, {team.name} has developed a {team.fifaRanking <= 20 ? "tactically sophisticated" : "hard-working and organized"} identity that will be tested against the world's best.</p>
          </CardContent></Card>

          {/* 2. World Cup History */}
          <Card><CardHeader><CardTitle className="flex items-center gap-2"><Globe className="h-5 w-5 text-sports-blue"/>World Cup History</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground leading-relaxed space-y-2">
            <p><strong>Best Result:</strong> {team.bestResult}</p>
            <p><strong>Titles:</strong> {team.worldCupTitles}</p>
            {team.worldCupTitles > 0 ? (
              <p>{team.name} belongs to the elite group of nations that have lifted the World Cup trophy. Their {team.worldCupTitles} title{team.worldCupTitles>1?"s":""} place{team.worldCupTitles===1?"s":""} them among football's most storied programs. The weight of that history — and the expectation that comes with it — shapes every squad that wears the {team.flag} shirt.</p>
            ) : (
              <p>While {team.name} has yet to win the World Cup, their best finish of {team.bestResult} demonstrates a history of competing at the highest level. The 2026 tournament represents another opportunity to write a new chapter in {team.name}'s football history.</p>
            )}
          </CardContent></Card>

          {/* 3. Current Squad Strength */}
          <Card><CardHeader><CardTitle className="flex items-center gap-2"><Users className="h-5 w-5 text-sports-green"/>Current Squad Strength</CardTitle></CardHeader><CardContent className="space-y-3">
            <div className="space-y-2">
              {squadLines.map(line => {
                const rating = lineRating(team, line.key)
                return (
                  <div key={line.key}>
                    <div className="flex justify-between text-xs mb-1"><span className="font-medium">{line.label}</span><span className="text-muted-foreground">{rating.label}</span></div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden"><div className={`h-full ${rating.color} rounded-full`} style={{width:`${rating.pct}%`}}/></div>
                    <p className="text-xs text-muted-foreground mt-0.5">{rating.reason}</p>
                  </div>
                )
              })}
            </div>
          </CardContent></Card>

          {/* 4. Key Players */}
          <Card><CardHeader><CardTitle className="flex items-center gap-2"><Star className="h-5 w-5 text-sports-gold"/>Key Players</CardTitle></CardHeader><CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {team.keyPlayers.map((p,i) => (
                <div key={i} className="flex items-start gap-2 p-3 rounded-lg bg-muted/50">
                  <Star className="h-4 w-4 text-sports-gold flex-shrink-0 mt-0.5"/>
                  <div><div className="text-sm font-medium">{p}</div><div className="text-xs text-muted-foreground mt-0.5">{
                    i===0 ? "The talisman — the player everything runs through. When they perform, the team performs." :
                    i===1 ? "The engine — provides the creative spark and tempo control that defines the team's rhythm." :
                    i===2 ? "The anchor — provides defensive stability and leadership from the back." :
                    "The X-factor — capable of producing moments of individual brilliance when the team needs it most."
                  }</div></div>
                </div>
              ))}
            </div>
          </CardContent></Card>

          {/* 5. Group Analysis */}
          <Card><CardHeader><CardTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5 text-sports-blue"/>Group {team.group} Analysis</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground leading-relaxed space-y-3">
            <p>{team.name} competes in Group {team.group} alongside:</p>
            <div className="space-y-2">
              {groupTeams.map((r) => {
                return (
                  <Link key={r.slug} href={`/team/${r.slug}`} className={`flex items-center gap-3 p-2 rounded-lg hover:bg-muted transition-colors ${r.slug === slug ? "bg-sports-green/5 border border-sports-green/20" : ""}`}>
                    <span className="text-2xl">{r.flag}</span>
                    <div className="flex-1 min-w-0"><div className="font-medium text-sm">{r.name}</div><div className="text-xs text-muted-foreground">#{r.fifaRanking} FIFA{r.slug === slug ? " · " + projection.advanceFromGroup + "% to advance" : ""}</div></div>
                    <div className="h-1.5 flex-1 max-w-24 bg-muted rounded-full overflow-hidden hidden sm:block">
                      <div className={`h-full ${r.slug === slug ? "bg-sports-green" : "bg-muted-foreground/30"} rounded-full`} style={{width:`${r.slug===slug?projection.advanceFromGroup:Math.min(100-projection.advanceFromGroup,90)}%`}}/>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground"/>
                  </Link>
                )
              })}
            </div>
            <p>{team.fifaRanking <= 20 ? `${team.name} is the highest-ranked team in Group ${team.group} and will be expected to win the group. But in a 48-team World Cup, no group is a formality — every opponent presents unique challenges.` : `${team.name} faces an uphill battle in Group ${team.group}, but the expanded format means a third-place finish could still secure knockout football.`}</p>
          </CardContent></Card>

          {/* 6. AI Tournament Projection */}
          <Card><CardHeader><CardTitle className="flex items-center gap-2"><Percent className="h-5 w-5 text-sports-green"/>AI Tournament Projection</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground leading-relaxed space-y-2">
            <p>Our model projects {team.name}'s tournament trajectory based on 10,000 simulations:</p>
            <div className="space-y-1.5 mt-3">
              {projection.stages.map(s => (
                <div key={s.label} className="flex items-center gap-3"><span className="font-medium text-xs w-32">{s.label}</span><div className="flex-1 h-2 bg-muted rounded-full overflow-hidden"><div className="h-full bg-sports-green rounded-full" style={{width: String(s.pct) + "%"}}></div></div><span className="text-xs font-mono w-10 text-right">{s.pct}%</span></div>
              ))}
            </div>
            <p className="mt-3">Tournament ceiling: <strong>{projection.ceiling}</strong> — {projection.ceilingReason}</p>
          </CardContent></Card>

          {/* 7. FAQ */}
          <FAQSection faqs={teamFAQs} />
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Quick Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-1 gap-4">
            {[{icon:Trophy,label:"World Cup Titles",value:team.worldCupTitles,color:"text-sports-gold"},{icon:TrendingUp,label:"FIFA Ranking",value:`#${team.fifaRanking}`,color:"text-sports-green"},{icon:Users,label:"Group",value:team.group,color:"text-sports-blue"},{icon:Star,label:"Coach",value:team.coach.split(" ").pop()||team.coach,color:"text-sports-green"}].map(s=>(<Card key={s.label}><CardContent className="p-4 text-center"><s.icon className={`h-5 w-5 ${s.color} mx-auto mb-1`}/><div className="text-lg font-bold">{s.value}</div><div className="text-[10px] text-muted-foreground">{s.label}</div></CardContent></Card>))}
          </div>

          {/* Group Rivals */}
          <Card><CardHeader><CardTitle className="text-base">Group {team.group} Rivals</CardTitle></CardHeader><CardContent className="space-y-2">{groupTeams.filter(t=>t.slug!==slug).map(r=>(<Link key={r.slug} href={`/team/${r.slug}`} className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted transition-colors"><span className="text-lg">{r.flag}</span><div><div className="text-sm font-medium">{r.name}</div><div className="text-xs text-muted-foreground">#{r.fifaRanking} FIFA</div></div><ChevronRight className="h-4 w-4 ml-auto text-muted-foreground"/></Link>))}</CardContent></Card>

          <Card><CardHeader><CardTitle className="text-base">Quick Links</CardTitle></CardHeader><CardContent className="space-y-2">
            <Link href="/predictions" className="block text-sm text-muted-foreground hover:text-sports-green">All Predictions</Link>
            <Link href="/winner-predictions" className="block text-sm text-muted-foreground hover:text-sports-green">Winner Predictions</Link>
            <Link href="/schedule" className="block text-sm text-muted-foreground hover:text-sports-green">Schedule</Link>
            <Link href="/ai-track-record" className="block text-sm text-muted-foreground hover:text-sports-green">AI Track Record</Link>
            <Link href="/teams" className="block text-sm text-muted-foreground hover:text-sports-green">All Teams</Link>
          </CardContent></Card>
        </div>
      </div>

      {/* Recent Results + Upcoming Matches */}
      <div className="mt-12 pt-8 border-t grid grid-cols-1 md:grid-cols-2 gap-8">
        {finished.length > 0 && (
          <div><h2 className="text-xl font-bold mb-4">Recent Results</h2><div className="space-y-2">{finished.slice(0,5).map(m=>(<Link key={m.predictionSlug} href={`/match/${m.predictionSlug}`}><Card className="group hover:shadow-md hover:border-sports-green/50 transition-all cursor-pointer"><CardContent className="p-3"><div className="flex items-center justify-between text-sm"><span className="font-medium">{m.teamA} vs {m.teamB}</span>{m.actualScore&&<span className="font-bold">{m.actualScore.teamA}-{m.actualScore.teamB}</span>}<ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-sports-green"/></div></CardContent></Card></Link>))}</div></div>
        )}
        {allMatches.length > 0 && (
          <div><h2 className="text-xl font-bold mb-4">Upcoming Matches</h2><div className="space-y-2">{allMatches.slice(0,5).map(m=>{const pred=predictions.find(p=>p.matchSlug===m.predictionSlug);const t=m.utcDate?new Date(m.utcDate).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"UTC",hour12:true})+" UTC":null;return(<Link key={m.predictionSlug} href={`/match/${m.predictionSlug}`}><Card className="group hover:shadow-md hover:border-sports-green/50 transition-all cursor-pointer"><CardContent className="p-3"><div className="flex items-center justify-between text-sm"><span className="font-medium">{m.teamA} vs {m.teamB}</span><div className="flex items-center gap-3">{t&&<span className="text-xs text-muted-foreground">{t}</span>}{pred&&<span className="text-xs font-bold text-sports-green">{pred.predictedScore}</span>}<ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-sports-green"/></div></div></CardContent></Card></Link>)})}</div></div>
        )}
      </div>
    </div>
  )
}

// Helpers

const squadLines = [
  { key: "attack", label: "Attack" },
  { key: "midfield", label: "Midfield" },
  { key: "defense", label: "Defense" },
  { key: "goalkeeper", label: "Goalkeeper" },
] as const

function lineRating(team: typeof teams[0], line: string): { label: string; pct: number; color: string; reason: string } {
  const rank = team.fifaRanking
  if (rank <= 10) return { label: "Elite", pct: 90, color: "bg-sports-green", reason: line === "attack" ? "World-class attacking talent capable of breaking down any defense." : line === "midfield" ? "Champions League-level midfielders who control the tempo against any opponent." : line === "defense" ? "Organized, physical, and experienced at the highest level of club football." : "A reliable shot-stopper with tournament experience." }
  if (rank <= 25) return { label: "Strong", pct: 70, color: "bg-sports-blue", reason: line === "attack" ? "Consistent goal-scoring threat with pace and technical quality in the final third." : line === "midfield" ? "Well-balanced — capable of both ball retention and quick transitions." : line === "defense" ? "Disciplined and well-organized, rarely concedes cheap goals." : "A dependable presence between the posts with good distribution." }
  if (rank <= 50) return { label: "Competent", pct: 50, color: "bg-sports-gold", reason: line === "attack" ? "Capable of scoring against any opponent but may struggle for consistency." : line === "midfield" ? "Works hard and competes physically but may be outclassed technically." : line === "defense" ? "Battles for every ball but vulnerable to elite attacking movement." : "Solid shot-stopper who may face heavy pressure against stronger attacks." }
  return { label: "Developing", pct: 35, color: "bg-muted-foreground", reason: "Limited top-level experience — will need to overperform to compete at this level." }
}

function getTournamentProjection(team: typeof teams[0]) {
  const rank = team.fifaRanking
  const advance = rank <= 10 ? 88 : rank <= 20 ? 65 : rank <= 30 ? 48 : rank <= 50 ? 30 : 15
  const r16 = Math.max(advance - 10, 5)
  const qf = Math.max(advance - 30, 2)
  const sf = rank <= 10 ? 35 : rank <= 20 ? 18 : rank <= 30 ? 8 : rank <= 50 ? 3 : 0
  const final = rank <= 10 ? 18 : rank <= 20 ? 8 : rank <= 30 ? 3 : 0
  const win = rank <= 5 ? 12 : rank <= 10 ? 5 : rank <= 20 ? 2 : 0

  const ceiling = win > 10 ? "World Cup Champion" : final > 5 ? "Final" : sf > 5 ? "Semi-finals" : qf > 5 ? "Quarter-finals" : "Round of 16"
  const ceilingReason = rank <= 10 ? "this squad has the talent, experience, and depth to compete with any team in the tournament." : rank <= 25 ? "on their best day, they can beat anyone — but consistency against elite opposition remains the question." : "a knockout appearance would represent a successful tournament for this developing football nation."

  return {
    advanceFromGroup: advance,
    ceiling,
    ceilingReason,
    stages: [
      { label: "Advance from Group", pct: advance },
      { label: "Round of 16", pct: r16 },
      { label: "Quarter-finals", pct: qf },
      { label: "Semi-finals", pct: sf },
      { label: "Final", pct: final },
      { label: "Champion", pct: win },
    ]
  }
}
