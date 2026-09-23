import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Breadcrumbs } from "@/components/Breadcrumbs"
import { JsonLd, breadcrumbJsonLd, footballMatchJsonLd } from "@/lib/jsonld"
import { SITE_URL } from "@/lib/constants"
import { getStaticPremierLeagueMatchParams, resolveStaticMatch } from "@/lib/football/static-queries"
import { buildMatchUrl, mapMatchEventStatus } from "@/lib/football/match-url"
import { MatchDetail } from "@/components/football/MatchDetail"
import { MatchPredictionCard } from "@/components/predictions/MatchPredictionCard"
import { getPublicMatchPrediction, type PublicMatchPrediction } from "@/lib/predictions/public-prediction"
import type { MatchDetailFixture } from "@/lib/football/match-logic"

export const dynamicParams = false

export function generateStaticParams() {
  return getStaticPremierLeagueMatchParams()
}

function predictionPageTitle(fixture: MatchDetailFixture, prediction: PublicMatchPrediction): string {
  const matchup = `${fixture.homeTeam.name} vs ${fixture.awayTeam.name}`
  return prediction.status === "sealed"
    ? `${matchup} Prediction, Score & AI Analysis`
    : `${matchup} Prediction Review & Result`
}

function predictionPageDescription(fixture: MatchDetailFixture): string {
  const matchup = `${fixture.homeTeam.name} vs ${fixture.awayTeam.name}`
  return `Premier League 2026/27 AI prediction for ${matchup}: AI predicted score, 1X2 probabilities, confidence and analysis.`
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const res = resolveStaticMatch(slug, "premier-league")
  if (res.kind !== "ok") {
    return { title: "Match Not Found", robots: { index: false, follow: false } }
  }
  const { fixture } = res.data
  const prediction = getPublicMatchPrediction(fixture)
  const title = predictionPageTitle(fixture, prediction)
  const description = predictionPageDescription(fixture)
  return {
    title,
    description,
    alternates: { canonical: buildMatchUrl(fixture, fixture.competitionSlug) },
    openGraph: { title: `${title} | AI Predictor`, description },
  }
}

export default async function PremierLeagueMatchPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const res = resolveStaticMatch(slug, "premier-league")

  if (res.kind === "not_found") notFound()

  const { data } = res
  const { fixture } = data
  const prediction = getPublicMatchPrediction(fixture)

  const breadcrumbs = [
    { name: "Home", url: "/" },
    { name: "Premier League", url: "/premier-league" },
    { name: "Matches", url: "/premier-league/matches" },
    {
      name: `${fixture.homeTeam.name} vs ${fixture.awayTeam.name}`,
      url: buildMatchUrl(fixture, fixture.competitionSlug),
    },
  ]

  const sportsEvent = footballMatchJsonLd({
    name: `${fixture.homeTeam.name} vs ${fixture.awayTeam.name}`,
    startDate: fixture.kickoffAt,
    eventStatus: mapMatchEventStatus(fixture.status),
    url: `${SITE_URL}${buildMatchUrl(fixture, fixture.competitionSlug)}`,
    homeTeam: { name: fixture.homeTeam.name, url: `${SITE_URL}/clubs/${fixture.homeTeam.slug}` },
    awayTeam: { name: fixture.awayTeam.name, url: `${SITE_URL}/clubs/${fixture.awayTeam.slug}` },
    ...(fixture.venueName ? { venue: { name: fixture.venueName, city: fixture.venueCity ?? "" } } : {}),
  })

  return (
    <>
      <JsonLd data={breadcrumbJsonLd(breadcrumbs, SITE_URL)} />
      <JsonLd data={sportsEvent} />

      <div className="container mx-auto max-w-7xl px-4 py-12">
        <Breadcrumbs items={breadcrumbs} />
        <MatchDetail data={data} />
        <div className="mt-10">
          <MatchPredictionCard prediction={prediction} />
        </div>
        <p className="mt-10 text-xs text-muted-foreground">
          Match data is sourced from football-data.org. Scores and status updates may be delayed.
        </p>
      </div>
    </>
  )
}
