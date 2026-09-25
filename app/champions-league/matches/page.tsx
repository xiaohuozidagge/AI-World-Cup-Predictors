import type { Metadata } from "next"
import { Suspense } from "react"
import { Breadcrumbs } from "@/components/Breadcrumbs"
import { JsonLd, breadcrumbJsonLd } from "@/lib/jsonld"
import { SITE_URL } from "@/lib/constants"
import { formatUtcDate, formatUtcTime } from "@/lib/format-utc"
import { STATIC_DATA_AS_OF } from "@/lib/football/match-logic"
import { getStaticMatchDirectoryData } from "@/lib/football/static-queries"
import { MatchDirectory } from "@/components/football/MatchDirectory"
import { MatchDirectoryClient } from "@/components/football/MatchDirectoryClient"

export const metadata: Metadata = {
  title: "Champions League Fixtures & Results 2026/27",
  description:
    "Browse the full Champions League fixture list and results, grouped by matchday. Match data is sourced from football-data.org.",
  alternates: { canonical: "/champions-league/matches" },
  openGraph: {
    title: "Champions League Fixtures & Results 2026/27 | AI Predictor",
    description:
      "Browse the full Champions League fixture list and results, grouped by matchday. Match data is sourced from football-data.org.",
  },
}

const breadcrumbs = [
  { name: "Home", url: "/" },
  { name: "Champions League", url: "/champions-league" },
  { name: "Matches", url: "/champions-league/matches" },
]

export default function ChampionsLeagueMatchesPage() {
  const data = getStaticMatchDirectoryData("champions-league")

  return (
    <>
      <JsonLd data={breadcrumbJsonLd(breadcrumbs, SITE_URL)} />

      <div className="container mx-auto max-w-7xl px-4 py-12">
        <Breadcrumbs items={breadcrumbs} />

        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Champions League Fixtures &amp; Results</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Browse every Champions League fixture and result, grouped by matchday. Use the filters to jump to a
            specific stage or matchday.
          </p>
          {data.lastUpdatedAt && (
            <p className="mt-2 text-sm text-muted-foreground">
              Last updated {formatUtcDate(data.lastUpdatedAt)} · {formatUtcTime(data.lastUpdatedAt)}
            </p>
          )}
        </header>

        <Suspense
          fallback={
            <MatchDirectory
              data={data}
              view="overview"
              page={1}
              filter={{ matchweek: null, stage: null }}
              nowIso={STATIC_DATA_AS_OF}
            />
          }
        >
          <MatchDirectoryClient data={data} />
        </Suspense>

        <p className="mt-10 text-xs text-muted-foreground">
          Match data is sourced from football-data.org. Scores and status updates may be delayed.
        </p>
      </div>
    </>
  )
}
