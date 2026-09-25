import type { Metadata } from "next"
import Link from "next/link"
import { Breadcrumbs } from "@/components/Breadcrumbs"
import { JsonLd, breadcrumbJsonLd } from "@/lib/jsonld"
import { SITE_URL } from "@/lib/constants"
import { getStaticCompetitionPageData } from "@/lib/football/static-queries"
import { CompetitionStats } from "@/components/football/CompetitionStats"
import { FixtureList } from "@/components/football/FixtureList"
import { formatUtcDate, formatUtcTime } from "@/lib/format-utc"

export const metadata: Metadata = {
  title: "Champions League Fixtures & Results",
  description:
    "View upcoming Champions League fixtures, recent results and match data, with AI-powered predictions coming soon.",
  alternates: { canonical: "/champions-league" },
  openGraph: {
    title: "Champions League Fixtures & Results | AI Predictor",
    description:
      "View upcoming Champions League fixtures, recent results and match data, with AI-powered predictions coming soon.",
  },
}

const breadcrumbs = [
  { name: "Home", url: "/" },
  { name: "Champions League", url: "/champions-league" },
]

export default function ChampionsLeaguePage() {
  const data = getStaticCompetitionPageData("champions-league")

  return (
    <>
      <JsonLd data={breadcrumbJsonLd(breadcrumbs, SITE_URL)} />

      <div className="container mx-auto max-w-7xl px-4 py-12">
        <Breadcrumbs items={breadcrumbs} />

        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Champions League Fixtures &amp; Results</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Champions League fixtures, recent results and data-driven match analysis from AI Predictor.
          </p>
          <Link
            href="/champions-league/matches"
            className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-sports-green hover:underline"
          >
            View all matches →
          </Link>
        </header>

        {data.lastUpdatedAt && (
          <p className="mb-4 text-sm text-muted-foreground">
            Last updated {formatUtcDate(data.lastUpdatedAt)} ·{" "}
            {formatUtcTime(data.lastUpdatedAt)}
          </p>
        )}

        <CompetitionStats stats={data.stats} />

        <section className="mt-12">
          <h2 className="mb-4 text-xl font-semibold tracking-tight">Upcoming Matches</h2>
          <FixtureList fixtures={data.upcoming} emptyMessage="No upcoming matches are currently available." />
        </section>

        <section className="mt-12">
          <h2 className="mb-4 text-xl font-semibold tracking-tight">Recent Results</h2>
          <FixtureList fixtures={data.recent} emptyMessage="No completed matches are currently available." />
        </section>

        <section className="mt-12 rounded-xl border bg-muted/30 p-6">
          <p className="text-sm text-muted-foreground">
            AI prediction features will be added after the match model is validated.
          </p>
        </section>

        <p className="mt-6 text-xs text-muted-foreground">
          Match schedules and results are sourced from football-data.org. Scores and status updates on the free
          data tier may be delayed.
        </p>
      </div>
    </>
  )
}
