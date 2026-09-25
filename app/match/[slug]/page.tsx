import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Calendar, Clock, MapPin, Star, TrendingUp, ChevronRight, Shield, Zap, Trophy } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ProbabilityBar } from "@/components/ProbabilityBar"
import { FAQSection } from "@/components/FAQSection"
import { JsonLd, faqJsonLd, breadcrumbJsonLd, sportsEventJsonLd } from "@/lib/jsonld"
import { matches } from "@/data/matches"
import { teams, getTeamsByGroup } from "@/data/teams"
import { generatePrediction } from "@/lib/prediction-engine"
import { SITE_URL } from "@/lib/constants"
import { findSyncedMatchBySlug, isMatchFinished, getSyncedDataAsOf } from "@/lib/synced-data"
import { getPredictionAccuracy, accuracyEmoji, accuracyColor } from "@/lib/predictionAccuracy"
import { PredictionShareModule } from "@/components/PredictionShareModule"
import { getRelatedMatches } from "@/lib/getRelatedMatches"

export async function generateStaticParams() {
  return matches.filter((m) => m.predictionSlug !== undefined).map((m) => ({ slug: m.predictionSlug! }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const match = matches.find(m => m.predictionSlug === slug)
  if (!match) return { title: "Prediction Not Found" }
  const teamAData = teams.find(t => t.name === match.teamA)
  const teamBData = teams.find(t => t.name === match.teamB)
  const p = teamAData && teamBData ? generatePrediction(match.teamA, match.teamB, teamAData.fifaRanking, teamBData.fifaRanking, match.stage, match.group || "", match.date, match.stadium, match.city, teamAData.keyPlayers, teamBData.keyPlayers) : null
  const title = `${match.teamA} vs ${match.teamB} Prediction — World Cup 2026`
  return { title, description: `AI prediction for ${match.teamA} vs ${match.teamB}. ${p ? `Win probability: ${match.teamA} ${p.teamAWinProbability}%, predicted score ${p.predictedScore}.` : ""}Analysis, form, and key factors.`, openGraph: { title, description: title, type: "article", publishedTime: "2026-06-09T00:00:00Z", modifiedTime: getSyncedDataAsOf() }, alternates: { canonical: `/match/${slug}` } }
}

export default async function MatchPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const match = matches.find(m => m.predictionSlug === slug)
  if (!match) notFound()
  const teamAData = teams.find(t => t.name === match.teamA)
  const teamBData = teams.find(t => t.name === match.teamB)
  if (!teamAData || !teamBData) notFound()

  const prediction = generatePrediction(match.teamA, match.teamB, teamAData.fifaRanking, teamBData.fifaRanking, match.stage, match.group || "", match.date, match.stadium, match.city, teamAData.keyPlayers, teamBData.keyPlayers)
  const synced = findSyncedMatchBySlug(match.slug)
  const isFinished = isMatchFinished(synced)
  const actualScore = synced?.actualScore
  const accuracy = isFinished && actualScore ? getPredictionAccuracy(prediction.predictedScore, actualScore) : null
  const relatedMatches = getRelatedMatches(slug, 4)
  const groupTeams = (match.group && match.group.length === 1) ? getTeamsByGroup(match.group) : []
  const aProb = prediction.teamAWinProbability
  const bProb = prediction.teamBWinProbability
  const drawProb = prediction.drawProbability
  const rankingGap = Math.abs(teamAData.fifaRanking - teamBData.fifaRanking)

  // Dynamic key factors — vary per match based on context
  const keyFactors = buildKeyFactors(match, teamAData, teamBData, aProb, bProb, drawProb, rankingGap)

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8">
      <JsonLd data={faqJsonLd(prediction.faq)} />
      <JsonLd data={breadcrumbJsonLd([{name:"Home",url:"/"},{name:"Predictions",url:"/predictions"},{name:`${match.teamA} vs ${match.teamB}`,url:`/match/${slug}`}], SITE_URL)} />
      <JsonLd data={sportsEventJsonLd({name:`${match.teamA} vs ${match.teamB} — FIFA World Cup 2026`,teamA:match.teamA,teamB:match.teamB,date:match.date,stadium:match.stadium,city:match.city})} />

      <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-6"><Link href="/" className="hover:text-sports-green">Home</Link><ChevronRight className="h-3 w-3"/><Link href="/predictions" className="hover:text-sports-green">Predictions</Link><ChevronRight className="h-3 w-3"/><span className="text-foreground font-medium">{match.teamA} vs {match.teamB}</span></nav>

      <div className="mb-8">
        <Badge variant="secondary" className="mb-3">{match.stage}{match.group && match.group.length === 1 ? ` · Group ${match.group}` : ""}</Badge>
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight mb-3">{match.teamA} vs {match.teamB} {isFinished ? "Result" : "Prediction"}</h1>
        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-1"><Calendar className="h-4 w-4"/> {new Date(match.date).toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric",timeZone:"UTC"})}</span>
          {synced?.utcDate && <span className="flex items-center gap-1"><Clock className="h-4 w-4"/> {new Date(synced.utcDate).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"UTC",hour12:true})} UTC</span>}
          <span className="flex items-center gap-1"><MapPin className="h-4 w-4"/> {match.stadium}, {match.city}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">

          {/* 1. Match Overview — uses team descriptions (hand-written, unique per team) */}
          <Card><CardHeader><CardTitle>Match Overview</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-3">
            <p>{teamAData.description}</p>
            <p>{teamBData.description}</p>
            <p className="pt-2 border-t">
              {match.stage === "Group Stage"
                ? `This Group ${match.group} encounter at ${match.stadium} in ${match.city} is one of six fixtures that will determine which two teams advance automatically to the Round of 32. A third-place finish may still be enough to progress, adding extra strategic complexity to the group dynamics.`
                : match.stage === "Final"
                ? `The World Cup final at ${match.stadium}. 104 matches, 48 teams, 39 days — and it all comes down to this. One of these two teams will be crowned world champion.`
                : `A ${match.stage.toLowerCase()} showdown at ${match.stadium}. There are no second chances from here — the loser goes home, and the pressure of single-elimination football will shape every decision on the pitch.`}
            </p>
          </CardContent></Card>

          {/* 2. Prediction Summary */}
          <Card className={isFinished ? "opacity-75" : "border-sports-green/30"}>
            <CardHeader><CardTitle>{isFinished ? "Result & Prediction Review" : "AI Prediction"}</CardTitle></CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 text-center"><div className="text-4xl mb-2">{teamAData.flag}</div><div className="font-bold text-lg">{match.teamA}</div><div className="text-xs text-muted-foreground">#{teamAData.fifaRanking} FIFA</div></div>
                <div className="text-center"><div className="text-3xl font-extrabold text-sports-green mb-1">{prediction.predictedScore}</div><div className="text-xs text-muted-foreground">Predicted Score</div></div>
                <div className="flex-1 text-center"><div className="text-4xl mb-2">{teamBData.flag}</div><div className="font-bold text-lg">{match.teamB}</div><div className="text-xs text-muted-foreground">#{teamBData.fifaRanking} FIFA</div></div>
              </div>
              {isFinished && actualScore && (<div className="border-t pt-4"><div className="text-center mb-3"><span className="text-sm font-semibold text-muted-foreground uppercase">Final Result</span></div><div className="flex items-center justify-between gap-4"><div className="flex-1 text-center"><span className="text-2xl font-extrabold">{actualScore.teamA}</span></div><div className="text-center"><span className="text-lg font-bold text-muted-foreground">-</span></div><div className="flex-1 text-center"><span className="text-2xl font-extrabold">{actualScore.teamB}</span></div></div>{accuracy && <div className="text-center mt-3"><span className={`text-sm font-semibold ${accuracyColor(accuracy)}`}>{accuracyEmoji(accuracy)} {accuracy}</span><span className="text-xs text-muted-foreground ml-2">Predicted: {prediction.predictedScore}</span><div className="mt-2"><Link href="/ai-track-record" className="text-xs text-sports-green hover:underline">View Full AI Record →</Link></div></div>}</div>)}
              <div><h4 className="text-sm font-semibold mb-3">Win Probability</h4><ProbabilityBar a={aProb} draw={drawProb} b={bProb} size="lg"/></div>
            </CardContent>
          </Card>

          {/* 3. AI Match Insight — unique per match from prediction engine */}
          <Card><CardHeader><CardTitle className="flex items-center gap-2"><TrendingUp className="h-5 w-5 text-sports-green"/>AI Match Insight</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-3">
            <p>{prediction.analysis}</p>
            <p className="pt-2 border-t">Our model ran 10,000 match simulations. {match.teamA} won in {aProb}% of scenarios, {match.teamB} in {bProb}%, and the remaining {drawProb}% ended level. {drawProb > 25 ? "A draw is a very real possibility — our model sees this as the most likely alternative outcome." : "The model is relatively confident that a decisive result is more likely than a stalemate."}</p>
            {aProb > 60 && <p className="font-medium text-foreground">Upset scenario: an early goal for {match.teamB} would fundamentally reshape the match. If {match.teamB} scores first, their compact defensive shape becomes an asset rather than a limitation.</p>}
            {bProb > 60 && <p className="font-medium text-foreground">Upset scenario: {match.teamA} scoring first would throw the favorite's game plan into disarray. A 1-0 lead with 60+ minutes to defend is {match.teamA}'s most realistic path to an upset.</p>}
            {aProb <= 60 && bProb <= 60 && <p className="font-medium text-foreground">This is projected as one of the tournament's tighter contests. The 10,000-simulation spread is narrow — small margins like a set-piece conversion or a goalkeeping error are proportionally more likely to decide the outcome here than in most fixtures.</p>}
          </CardContent></Card>

          {/* 4. Team Analysis — uses team descriptions + form from engine */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <Card><CardHeader><CardTitle className="text-base flex items-center gap-2"><Shield className="h-4 w-4 text-sports-green"/>{match.teamA} Profile</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-2">
              <p className="text-foreground font-medium">{teamAData.description}</p>
              <div className="pt-2"><strong className="text-foreground">Key players:</strong> {teamAData.keyPlayers.slice(0,3).join(", ")}. {teamAData.keyPlayers[0]} is the name that opposition scouting reports highlight first.</div>
              <div className="pt-2"><strong className="text-foreground">Recent form:</strong> {prediction.teamForm.teamA}</div>
              <div className="pt-2 border-t"><Link href={`/team/${teamAData.slug}`} className="text-xs text-sports-green hover:underline">Full {teamAData.name} team profile →</Link></div>
            </CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base flex items-center gap-2"><Shield className="h-4 w-4 text-sports-blue"/>{match.teamB} Profile</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-2">
              <p className="text-foreground font-medium">{teamBData.description}</p>
              <div className="pt-2"><strong className="text-foreground">Key players:</strong> {teamBData.keyPlayers.slice(0,3).join(", ")}. {teamBData.keyPlayers[0]} is the name that opposition scouting reports highlight first.</div>
              <div className="pt-2"><strong className="text-foreground">Recent form:</strong> {prediction.teamForm.teamB}</div>
              <div className="pt-2 border-t"><Link href={`/team/${teamBData.slug}`} className="text-xs text-sports-green hover:underline">Full {teamBData.name} team profile →</Link></div>
            </CardContent></Card>
          </div>

          {/* 5. Key Factors — dynamically generated per match */}
          <Card><CardHeader><CardTitle className="flex items-center gap-2"><Zap className="h-5 w-5 text-sports-gold"/>Key Factors</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground leading-relaxed">
            <div className="space-y-3">
              {keyFactors.map((f, i) => (
                <div key={i}><strong className="text-foreground">{i+1}. {f.title}</strong><p>{f.body}</p></div>
              ))}
            </div>
          </CardContent></Card>

          {/* 6. Group Situation — only for group stage */}
          {match.group && match.group.length === 1 && groupTeams.length > 0 && (
            <Card><CardHeader><CardTitle className="flex items-center gap-2"><Trophy className="h-5 w-5 text-sports-blue"/>Group {match.group} Context</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground leading-relaxed space-y-2">
              <p>This result will directly impact the Group {match.group} standings, where {groupTeams.map(t => t.name).join(", ")} are competing for two automatic qualification spots and a potential best-third-place berth.</p>
              <div className="flex flex-wrap gap-2">{groupTeams.map(t => (<Link key={t.slug} href={`/team/${t.slug}`}><Badge variant="outline" className="cursor-pointer hover:bg-muted">{t.flag} {t.name}</Badge></Link>))}</div>
              <p>{aProb > 55 ? `${match.teamA} enters as the projected group leader — a win here would strengthen their position at the top of Group ${match.group}. ` : bProb > 55 ? `${match.teamB} enters as the projected group leader — a win here would strengthen their position at the top of Group ${match.group}. ` : ""}The winner of this match takes a significant step toward the knockout stage; the loser faces increased pressure in their remaining fixtures.</p>
            </CardContent></Card>
          )}

          {/* 7. Key Players */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <Card><CardHeader><CardTitle className="text-base flex items-center gap-2"><Star className="h-4 w-4 text-sports-gold"/>{match.teamA} Players to Watch</CardTitle></CardHeader>
            <CardContent><ul className="space-y-1.5">{prediction.keyPlayers.teamA.map((p,i)=>(<li key={i} className="text-sm text-muted-foreground flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-sports-green"/>{p}</li>))}</ul></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base flex items-center gap-2"><Star className="h-4 w-4 text-sports-gold"/>{match.teamB} Players to Watch</CardTitle></CardHeader>
            <CardContent><ul className="space-y-1.5">{prediction.keyPlayers.teamB.map((p,i)=>(<li key={i} className="text-sm text-muted-foreground flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-sports-blue"/>{p}</li>))}</ul></CardContent></Card>
          </div>

          {/* 8. FAQ */}
          <FAQSection faqs={prediction.faq} />

          {/* 9. Share */}
          {!isFinished && (
            <PredictionShareModule teamA={match.teamA} teamB={match.teamB} predictedScore={{teamA:parseInt(prediction.predictedScore.split("-")[0])||0,teamB:parseInt(prediction.predictedScore.split("-")[1])||0}} probabilities={{teamA:aProb,draw:drawProb,teamB:bProb}} confidence={Math.abs(aProb-bProb)>25?"High":Math.abs(aProb-bProb)>12?"Medium":"Low"} matchDate={match.date} utcDate={synced?.utcDate} stadium={match.stadium} url={`${SITE_URL}/match/${slug}`}/>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <Card><CardHeader><CardTitle className="text-base">Team Profiles</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <Link href={`/team/${teamAData.slug}`} className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted transition-colors"><span className="text-xl">{teamAData.flag}</span><span className="text-sm font-medium">{teamAData.name}</span><ChevronRight className="h-4 w-4 ml-auto text-muted-foreground"/></Link>
            <Link href={`/team/${teamBData.slug}`} className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted transition-colors"><span className="text-xl">{teamBData.flag}</span><span className="text-sm font-medium">{teamBData.name}</span><ChevronRight className="h-4 w-4 ml-auto text-muted-foreground"/></Link>
          </CardContent></Card>
          <Card><CardHeader><CardTitle className="text-base">Quick Links</CardTitle></CardHeader><CardContent className="space-y-2">
            <Link href="/winner-predictions" className="block text-sm text-muted-foreground hover:text-sports-green">Winner Predictions</Link>
            <Link href="/schedule" className="block text-sm text-muted-foreground hover:text-sports-green">Full Schedule</Link>
            <Link href="/simulator" className="block text-sm text-muted-foreground hover:text-sports-green">Match Simulator</Link>
            <Link href="/ai-track-record" className="block text-sm text-muted-foreground hover:text-sports-green">AI Track Record</Link>
          </CardContent></Card>
        </div>
      </div>

      {/* Related */}
      {relatedMatches.length > 0 && (
        <section className="mt-12 pt-8 border-t"><div className="mb-4"><h2 className="text-2xl font-bold">Related Predictions</h2><p className="text-muted-foreground text-sm mt-1">You may also like these upcoming World Cup matches</p></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{relatedMatches.map(rm=>{const ta=teams.find(t=>t.name===rm.teamA);const tb=teams.find(t=>t.name===rm.teamB);const rp=generatePrediction(rm.teamA,rm.teamB,ta?.fifaRanking||50,tb?.fifaRanking||50,rm.stage,rm.group||"",rm.date,rm.stadium,rm.city,ta?.keyPlayers||[],tb?.keyPlayers||[]);const t=rm.utcDate?new Date(rm.utcDate).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"UTC",hour12:true})+" UTC":null;return(<Link key={rm.predictionSlug} href={`/match/${rm.predictionSlug}`}><Card className="group hover:shadow-md hover:border-sports-green/50 transition-all cursor-pointer h-full"><CardContent className="p-4"><div className="flex items-center justify-between mb-2"><div className="flex items-center gap-2"><span className="text-lg">{ta?.flag}</span><span className="font-medium text-sm">{rm.teamA}</span></div><span className="text-xs text-muted-foreground">vs</span><div className="flex items-center gap-2"><span className="font-medium text-sm">{rm.teamB}</span><span className="text-lg">{tb?.flag}</span></div></div><div className="text-center mb-2"><span className="text-lg font-bold text-sports-green">{rp.predictedScore}</span><span className="text-xs text-muted-foreground ml-2">Predicted</span></div><div className="flex items-center justify-between text-[10px] text-muted-foreground">{t&&<span className="flex items-center gap-1"><Clock className="h-3 w-3"/>{t}</span>}<span className="text-xs text-sports-green font-medium group-hover:underline">View Prediction →</span></div></CardContent></Card></Link>)})}</div></section>
      )}
    </div>
  )
}

// Dynamic key factors — varies per match based on actual context
function buildKeyFactors(
  match: typeof matches[0],
  teamA: typeof teams[0],
  teamB: typeof teams[0],
  aProb: number, bProb: number, drawProb: number, rankingGap: number
): { title: string; body: string }[] {
  const factors: { title: string; body: string }[] = []

  if (rankingGap > 25) {
    factors.push({
      title: "The Ranking Gap",
      body: `The ${rankingGap}-place difference in FIFA rankings between ${teamA.name} (#${teamA.fifaRanking}) and ${teamB.name} (#${teamB.fifaRanking}) is one of the widest in the group stage. Historically, ranking gaps of this magnitude correspond to a win rate of over 70% for the higher-ranked side in World Cup play. ${teamB.name} will need to defy historical precedent.`
    })
  } else if (rankingGap > 10) {
    factors.push({
      title: "FIFA Ranking Differential",
      body: `${teamA.name} (#${teamA.fifaRanking}) and ${teamB.name} (#${teamB.fifaRanking}) are separated by ${rankingGap} places in the rankings — a gap that suggests a moderate favorite but nothing close to a foregone conclusion. Matches with this ranking profile have historically produced a wide range of outcomes.`
    })
  } else {
    factors.push({
      title: "Evenly Matched on Paper",
      body: `With only ${rankingGap} places separating them in the FIFA rankings, ${teamA.name} (#${teamA.fifaRanking}) and ${teamB.name} (#${teamB.fifaRanking}) enter this match as statistical near-equals. Ranking alone provides almost no predictive value — this will be decided by form, tactics, and individual moments.`
    })
  }

  if (drawProb > 25) {
    factors.push({
      title: "High Draw Probability",
      body: `Our model assigns a ${drawProb}% chance of a draw — among the highest in the group stage. Both teams have strong defensive structures that make breaking the deadlock difficult. The first goal carries disproportionate weight: whichever team scores it will likely control the match's remaining shape.`
    })
  } else {
    factors.push({
      title: "The First Goal",
      body: `In World Cup matches where the probability spread is this wide, the team that scores first wins approximately ${match.stage !== "Group Stage" ? "75%" : "68%"} of the time. An early goal by ${aProb > bProb ? teamB.name : teamA.name} would dramatically shift the projected outcome.`
    })
  }

  if (match.group && match.group.length === 1) {
    factors.push({
      title: "Group Stage Positioning",
      body: `This is matchday ${match.date <= "2026-06-16" ? "1" : match.date <= "2026-06-22" ? "2" : "3"} of Group ${match.group}. ${match.date >= "2026-06-24" ? "As a final group match, both teams will know exactly what result they need before kickoff — the simultaneous kickoff rule ensures no team can play for a mutually beneficial result." : "There are still group matches remaining after this fixture, meaning both teams approach it with the flexibility to manage risk rather than needing an all-or-nothing result."}`
    })
  }

  factors.push({
    title: match.stage !== "Group Stage" ? "Knockout Pressure" : "Squad Depth & Fatigue",
    body: match.stage !== "Group Stage"
      ? `Single-elimination football introduces psychological variables that no statistical model fully captures. Penalty shootout preparation, in-game tactical adjustments, and the ability to perform under elimination pressure will matter as much as the underlying numbers.`
      : `With matches every 3-4 days in the group stage, squad rotation is a hidden tactical variable. The team that manages its substitutes more effectively — bringing fresh legs into key positions in the final 25 minutes — gains a measurable physical advantage that compounds across the three group fixtures.`
  })

  return factors
}
