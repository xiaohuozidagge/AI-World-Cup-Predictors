import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Breadcrumbs } from "@/components/Breadcrumbs"
import { JsonLd, breadcrumbJsonLd, footballMatchJsonLd } from "@/lib/jsonld"
import { SITE_URL } from "@/lib/constants"
import { getStaticChampionsLeagueMatchParams, resolveStaticMatch } from "@/lib/football/static-queries"
import { buildMatchTitle, buildMatchDescription } from "@/lib/football/match-logic"
import { buildMatchUrl, mapMatchEventStatus } from "@/lib/football/match-url"
import { MatchDetail } from "@/components/football/MatchDetail"

export const dynamicParams = false

export function generateStaticParams() {
  return getStaticChampionsLeagueMatchParams()
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const res = resolveStaticMatch(slug, "champions-league")
  if (res.kind !== "ok") {
    return { title: "Match Not Found", robots: { index: false, follow: false } }
  }
  const { fixture } = res.data
  const title = buildMatchTitle(fixture)
  const description = buildMatchDescription(fixture)
  return {
    title,
    description,
    alternates: { canonical: buildMatchUrl(fixture, fixture.competitionSlug) },
    openGraph: { title: `${title} | AI Predictor`, description },
  }
}

export default async function ChampionsLeagueMatchPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const res = resolveStaticMatch(slug, "champions-league")

  if (res.kind === "not_found") notFound()

  const { data } = res
  const { fixture } = data

  const breadcrumbs = [
    { name: "Home", url: "/" },
    { name: "Champions League", url: "/champions-league" },
    { name: "Matches", url: "/champions-league/matches" },
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
        <p className="mt-10 text-xs text-muted-foreground">
          Match data is sourced from football-data.org. Scores and status updates may be delayed.
        </p>
      </div>
    </>
  )
}
