import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { CalendarDays, Clock } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Breadcrumbs } from "@/components/Breadcrumbs"
import { MatchStatusBadge } from "@/components/football/MatchStatusBadge"
import { JsonLd, breadcrumbJsonLd } from "@/lib/jsonld"
import { SITE_URL } from "@/lib/constants"
import { formatUtcDate, formatUtcTime } from "@/lib/format-utc"
import {
  getStaticClubPageData,
  getStaticClubParams,
  type Club,
  type ClubFixture,
  type ClubSplitRecord,
  type MatchOutcome,
} from "@/lib/football/static-club-queries"
import { buildMatchUrl } from "@/lib/football/match-url"

export const dynamicParams = false

export function generateStaticParams() {
  return getStaticClubParams()
}

function competitionPhrase(names: string[]): string {
  if (names.length > 1) return `across ${names.join(" and ")}`
  if (names.length === 1) return `in ${names[0]}`
  return "in the 2026 season"
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const data = getStaticClubPageData(slug)
  if (!data) return { title: "Club Not Found" }
  const names = data.competitions.map((c) => c.name)
  const title = `${data.club.name} Fixtures, Results & Stats`
  const description = `View ${data.club.name}'s upcoming fixtures, recent results and 2026 season statistics ${competitionPhrase(names)}.`
  return {
    title,
    description,
    alternates: { canonical: `/clubs/${slug}` },
    openGraph: { title: `${title} | AI Predictor`, description },
  }
}

// --- presentation helpers ----------------------------------------------------

function contextLabel(stage: string | null, matchweek: number | null): string {
  if (matchweek != null) return `Matchweek ${matchweek}`
  if (!stage) return "Fixture"
  return stage
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function opponentOf(fixture: ClubFixture, teamId: string): Club {
  return fixture.homeTeam.id === teamId ? fixture.awayTeam : fixture.homeTeam
}

function isHome(fixture: ClubFixture, teamId: string): boolean {
  return fixture.homeTeam.id === teamId
}

function outcomeFor(fixture: ClubFixture, teamId: string): MatchOutcome | null {
  if (fixture.status !== "FINISHED" || fixture.homeScore == null || fixture.awayScore == null) return null
  const home = isHome(fixture, teamId)
  const gf = home ? fixture.homeScore : fixture.awayScore
  const ga = home ? fixture.awayScore : fixture.homeScore
  if (gf > ga) return "W"
  if (gf < ga) return "L"
  return "D"
}

function matchDetailUrl(fixture: ClubFixture): string | null {
  if (fixture.providerFixtureId == null) return null
  return buildMatchUrl(
    { providerFixtureId: fixture.providerFixtureId, homeTeam: fixture.homeTeam, awayTeam: fixture.awayTeam },
    fixture.competition.slug,
  )
}

const OUTCOME_META: Record<MatchOutcome, { label: string; className: string }> = {
  W: { label: "Win", className: "bg-sports-green text-white" },
  D: { label: "Draw", className: "bg-muted-foreground text-white" },
  L: { label: "Loss", className: "bg-sports-gold text-white" },
}

function OutcomePill({ outcome }: { outcome: MatchOutcome }) {
  const meta = OUTCOME_META[outcome]
  return (
    <span
      aria-label={meta.label}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold ${meta.className}`}
    >
      {outcome}
    </span>
  )
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-card p-4 text-center shadow-sm">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-bold tabular-nums">{value}</dd>
    </div>
  )
}

function SplitRow({ title, record }: { title: string; record: ClubSplitRecord }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="mt-1 text-sm tabular-nums text-foreground">
        {record.played}P · {record.won}W · {record.drawn}D · {record.lost}L · {record.goalsFor} GF ·{" "}
        {record.goalsAgainst} GA
        {record.goalDifference !== 0 && <span> · {record.goalDifference > 0 ? "+" : ""}{record.goalDifference} GD</span>}
      </div>
    </div>
  )
}

// --- page ---------------------------------------------------------------------

export default async function ClubPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const data = getStaticClubPageData(slug)
  if (!data) notFound()

  const { club, competitions, stats, upcoming, recent, lastUpdatedAt, currentSeason } = data
  const compNames = competitions.map((c) => c.name)

  const breadcrumbs = [
    { name: "Home", url: "/" },
    { name: "Clubs", url: "/clubs" },
    { name: club.name, url: `/clubs/${slug}` },
  ]

  const sportsTeamLd = {
    "@context": "https://schema.org",
    "@type": "SportsTeam",
    name: club.name,
    url: `${SITE_URL}/clubs/${slug}`,
    sport: "Soccer",
    ...(club.country ? { location: { "@type": "Place", name: club.country } } : {}),
    memberOf: competitions.map((c) => ({ "@type": "SportsOrganization", name: c.name })),
  }

  return (
    <>
      <JsonLd data={breadcrumbJsonLd(breadcrumbs, SITE_URL)} />
      <JsonLd data={sportsTeamLd} />

      <div className="container mx-auto max-w-7xl px-4 py-12">
        <Breadcrumbs items={breadcrumbs} />

        {/* Hero */}
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            {club.name} Fixtures, Results &amp; Stats
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {competitions.map((c) => (
              <Badge key={c.id} variant="secondary">
                {c.name}
              </Badge>
            ))}
            {club.country && <Badge variant="outline">{club.country}</Badge>}
            {currentSeason != null && <Badge variant="info">{currentSeason} Season</Badge>}
          </div>
          <p className="mt-4 max-w-2xl text-muted-foreground">
            Follow {club.name}&apos;s {currentSeason ?? 2026} fixtures, recent results and season statistics
            {compNames.length ? ` ${competitionPhrase(compNames)}` : ""}. Match data is updated regularly from our
            football data provider.
          </p>
          {lastUpdatedAt && (
            <p className="mt-2 text-sm text-muted-foreground">
              Last updated {formatUtcDate(lastUpdatedAt)} · {formatUtcTime(lastUpdatedAt)}
            </p>
          )}
        </header>

        {/* Season Overview */}
        <section aria-labelledby="season-overview">
          <Card>
            <CardHeader>
              <CardTitle id="season-overview" className="text-lg">
                Season Overview
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                <StatTile label="Played" value={stats.overall.played} />
                <StatTile label="Won" value={stats.overall.won} />
                <StatTile label="Drawn" value={stats.overall.drawn} />
                <StatTile label="Lost" value={stats.overall.lost} />
                <StatTile label="Goals For" value={stats.overall.goalsFor} />
                <StatTile label="Goals Against" value={stats.overall.goalsAgainst} />
                <StatTile label="Goal Difference" value={stats.overall.goalDifference} />
              </dl>

              <div className="mt-6 grid gap-4 sm:grid-cols-3">
                <SplitRow title="Home" record={stats.overall.home} />
                <SplitRow title="Away" record={stats.overall.away} />
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent Form</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {stats.overall.form.length === 0 ? (
                      <span className="text-sm text-muted-foreground">No completed matches yet.</span>
                    ) : (
                      stats.overall.form.map((o, i) => <OutcomePill key={i} outcome={o} />)
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <div className="mt-10 grid gap-8 lg:grid-cols-2">
          {/* Upcoming Fixtures */}
          <section aria-labelledby="upcoming-fixtures">
            <h2 id="upcoming-fixtures" className="mb-4 flex items-center gap-2 text-xl font-semibold tracking-tight">
              <CalendarDays className="h-5 w-5 text-sports-green" aria-hidden />
              Upcoming Fixtures
            </h2>
            {upcoming.length === 0 ? (
              <div className="rounded-xl border bg-muted/30 px-6 py-8 text-center text-sm text-muted-foreground">
                No upcoming fixtures are currently available.
              </div>
            ) : (
              <ul className="space-y-3">
                {upcoming.map((fixture) => {
                  const opponent = opponentOf(fixture, club.id)
                  const home = isHome(fixture, club.id)
                  const matchUrl = matchDetailUrl(fixture)
                  return (
                    <li key={fixture.id}>
                      <Card>
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between gap-2">
                            <MatchStatusBadge status={fixture.status} />
                            <span className="text-xs font-medium text-muted-foreground">
                              {contextLabel(fixture.stage, fixture.matchweek)}
                            </span>
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                            <Badge variant="outline">{home ? "Home" : "Away"}</Badge>
                            <span className="text-sm font-semibold">
                              {opponent.slug ? (
                                <Link href={`/clubs/${opponent.slug}`} className="hover:text-sports-green">
                                  {opponent.name}
                                </Link>
                              ) : (
                                opponent.name
                              )}
                            </span>
                            <span className="text-xs text-muted-foreground">{fixture.competition.name}</span>
                          </div>
                          <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1.5">
                              <Clock className="h-3.5 w-3.5" aria-hidden />
                              <time dateTime={fixture.kickoffAt}>
                                {formatUtcDate(fixture.kickoffAt)} · {formatUtcTime(fixture.kickoffAt)}
                              </time>
                            </span>
                            {matchUrl && (
                              <Link href={matchUrl} className="shrink-0 font-medium text-sports-green hover:underline">
                                Match details
                              </Link>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {/* Recent Results */}
          <section aria-labelledby="recent-results">
            <h2 id="recent-results" className="mb-4 flex items-center gap-2 text-xl font-semibold tracking-tight">
              <Clock className="h-5 w-5 text-sports-blue" aria-hidden />
              Recent Results
            </h2>
            {recent.length === 0 ? (
              <div className="rounded-xl border bg-muted/30 px-6 py-8 text-center text-sm text-muted-foreground">
                No completed matches are currently available.
              </div>
            ) : (
              <ul className="space-y-3">
                {recent.map((fixture) => {
                  const opponent = opponentOf(fixture, club.id)
                  const home = isHome(fixture, club.id)
                  const matchUrl = matchDetailUrl(fixture)
                  const outcome = outcomeFor(fixture, club.id)
                  return (
                    <li key={fixture.id}>
                      <Card>
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-muted-foreground">
                              {contextLabel(fixture.stage, fixture.matchweek)}
                            </span>
                            <span className="text-xs text-muted-foreground">{fixture.competition.name}</span>
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                            <Badge variant="outline">{home ? "Home" : "Away"}</Badge>
                            <span className="text-sm font-semibold">
                              {opponent.slug ? (
                                <Link href={`/clubs/${opponent.slug}`} className="hover:text-sports-green">
                                  {opponent.name}
                                </Link>
                              ) : (
                                opponent.name
                              )}
                            </span>
                            <span className="whitespace-nowrap text-sm font-bold tabular-nums">
                              {fixture.homeScore} <span className="text-muted-foreground">–</span> {fixture.awayScore}
                            </span>
                            {outcome && <OutcomePill outcome={outcome} />}
                          </div>
                          <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <time dateTime={fixture.kickoffAt}>{formatUtcDate(fixture.kickoffAt)}</time>
                            {matchUrl && (
                              <Link href={matchUrl} className="shrink-0 font-medium text-sports-green hover:underline">
                                Match details
                              </Link>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>

        {/* Performance by Competition */}
        {stats.byCompetition.length > 0 && (
          <section className="mt-12" aria-labelledby="by-competition">
            <h2 id="by-competition" className="mb-4 text-xl font-semibold tracking-tight">
              Performance by Competition
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {stats.byCompetition.map(({ competition, stats: rec }) => (
                <Card key={competition.id}>
                  <CardHeader>
                    <CardTitle className="text-base">{competition.name}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-sm tabular-nums text-muted-foreground">
                      <span className="font-semibold text-foreground">{rec.played}</span> Played ·{" "}
                      <span className="font-semibold text-foreground">{rec.won}</span> Won ·{" "}
                      <span className="font-semibold text-foreground">{rec.drawn}</span> Drawn ·{" "}
                      <span className="font-semibold text-foreground">{rec.lost}</span> Lost
                    </div>
                    <div className="mt-1 text-sm tabular-nums text-muted-foreground">
                      <span className="font-semibold text-foreground">{rec.goalsFor}</span> GF ·{" "}
                      <span className="font-semibold text-foreground">{rec.goalsAgainst}</span> GA ·{" "}
                      <span className="font-semibold text-foreground">
                        {rec.goalDifference > 0 ? "+" : ""}
                        {rec.goalDifference}
                      </span>{" "}
                      GD
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )}

        <p className="mt-10 text-xs text-muted-foreground">
          Match schedules and results are sourced from football-data.org. Scores and status updates may be delayed.
        </p>
      </div>
    </>
  )
}
