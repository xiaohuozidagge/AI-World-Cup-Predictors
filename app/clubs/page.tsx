import type { Metadata } from "next"
import Link from "next/link"
import { Trophy } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Breadcrumbs } from "@/components/Breadcrumbs"
import { JsonLd, breadcrumbJsonLd } from "@/lib/jsonld"
import { SITE_URL } from "@/lib/constants"
import { getStaticAllClubs, type ClubWithCompetitions } from "@/lib/football/static-club-queries"

export const metadata: Metadata = {
  title: "Football Clubs – Fixtures, Results & Stats",
  description:
    "Browse Premier League clubs with upcoming fixtures, recent results and season statistics.",
  alternates: { canonical: "/clubs" },
  openGraph: {
    title: "Football Clubs – Fixtures, Results & Stats | AI Predictor",
    description:
      "Browse Premier League clubs with upcoming fixtures, recent results and season statistics.",
  },
}

const breadcrumbs = [
  { name: "Home", url: "/" },
  { name: "Clubs", url: "/clubs" },
]

function ClubCard({ club }: { club: ClubWithCompetitions }) {
  const initial = club.name.trim().charAt(0).toUpperCase() || "•"
  return (
    <Link href={`/clubs/${club.slug}`} className="group block h-full">
      <Card className="h-full transition-colors hover:border-sports-green/50 hover:shadow-md">
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted text-base font-semibold text-foreground"
            >
              {initial}
            </span>
            <div className="min-w-0 flex-1">
              <div className="break-words font-semibold leading-tight">{club.name}</div>
              {club.shortName && club.shortName !== club.name && (
                <div className="mt-0.5 text-xs text-muted-foreground">{club.shortName}</div>
              )}
              {club.country && <div className="mt-0.5 text-xs text-muted-foreground">{club.country}</div>}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {club.competitions.map((c) => (
              <Badge key={c.id} variant="secondary">
                {c.name}
              </Badge>
            ))}
          </div>

          <div className="mt-4 text-sm font-medium text-sports-green group-hover:underline">View Club</div>
        </CardContent>
      </Card>
    </Link>
  )
}

export default function ClubsPage() {
  const clubs = getStaticAllClubs()

  const plClubs = clubs.filter((c) => c.competitions.some((comp) => comp.slug === "premier-league"))

  return (
    <>
      <JsonLd data={breadcrumbJsonLd(breadcrumbs, SITE_URL)} />

      <div className="container mx-auto max-w-7xl px-4 py-12">
        <Breadcrumbs items={breadcrumbs} />

        <header className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Football Clubs</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Browse Premier League clubs tracked by AI Predictor — upcoming fixtures, recent results and 2026 season
            statistics, updated regularly from our football data provider.
          </p>
        </header>

        <section>
          <div className="mb-4 flex items-center gap-2">
            <Trophy className="h-5 w-5 text-sports-green" aria-hidden />
            <h2 className="text-xl font-semibold tracking-tight">All Clubs</h2>
            <span className="text-sm text-muted-foreground">({clubs.length})</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {clubs.map((club) => (
              <ClubCard key={club.id} club={club} />
            ))}
          </div>
        </section>

        <section className="mt-12">
          <div className="mb-4 flex items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">Premier League Clubs</h2>
            <span className="text-sm text-muted-foreground">({plClubs.length})</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {plClubs.map((club) => (
              <ClubCard key={club.id} club={club} />
            ))}
          </div>
        </section>

        <p className="mt-10 text-xs text-muted-foreground">
          Match schedules and results are sourced from football-data.org. Scores and status updates on the free data
          tier may be delayed.
        </p>
      </div>
    </>
  )
}
