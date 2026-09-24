import type { Metadata } from "next"
import Link from "next/link"
import { CalendarDays } from "lucide-react"
import { Breadcrumbs } from "@/components/Breadcrumbs"
import { JsonLd, breadcrumbJsonLd } from "@/lib/jsonld"
import { SITE_URL } from "@/lib/constants"
import { getTodayPageData } from "@/lib/predictions/public-pages"
import { formatTransparencyDateTime } from "@/lib/predictions/public-prediction"
import { formatUtcDate } from "@/lib/format-utc"
import { PredictionListCard } from "@/components/predictions/PredictionListCard"

const breadcrumbs = [
  { name: "Home", url: "/" },
  { name: "Football Predictions Today", url: "/football-predictions-today" },
]

export function generateMetadata(): Metadata {
  const data = getTodayPageData()
  const title = data.isToday
    ? "Football Predictions Today | AI Scores & Match Analysis"
    : "Next Football Predictions | AI Scores & Match Analysis"
  const description = data.isToday
    ? "Today's sealed AI football predictions, predicted scores and 1X2 probabilities for the Premier League."
    : "The next sealed AI Premier League match predictions, with predicted scores and 1X2 probabilities."
  return {
    title,
    description,
    alternates: { canonical: "/football-predictions-today" },
    openGraph: { title, description },
  }
}

export default function FootballPredictionsTodayPage() {
  const data = getTodayPageData()

  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: data.heading,
    numberOfItems: data.matches.length,
    itemListElement: data.matches.map((m, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: `${m.homeName} vs ${m.awayName}`,
      url: `${SITE_URL}${m.url}`,
    })),
  }

  const matchdayLabel =
    data.matches.length > 0 ? formatUtcDate(data.matches[0].kickoffUtc) : data.referenceDateLabel

  return (
    <>
      <JsonLd data={breadcrumbJsonLd(breadcrumbs, SITE_URL)} />
      <JsonLd data={itemListJsonLd} />

      <div className="container mx-auto max-w-7xl px-4 py-12">
        <Breadcrumbs items={breadcrumbs} />

        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{data.heading}</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Sealed AI predictions with predicted scores and 1X2 probabilities for the next Premier League
            matchday.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            <CalendarDays className="mr-1 inline h-4 w-4" aria-hidden />
            Matchday {matchdayLabel} (UTC) · Schedule data updated:{" "}
            {formatTransparencyDateTime(data.scheduleUpdatedAt)}
          </p>
        </header>

        {!data.isToday && (
          <div className="mb-8 rounded-xl border bg-muted/30 p-4">
            <p className="text-sm text-muted-foreground">
              There are no Premier League matches in the current schedule snapshot for this date. Here are
              the next available predictions.
            </p>
          </div>
        )}

        <section>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.matches.map((card) => (
              <PredictionListCard key={card.slug} card={card} />
            ))}
          </div>
        </section>

        {data.latestReviews.length > 0 && (
          <section className="mt-14">
            <h2 className="mb-4 text-xl font-semibold tracking-tight">Latest Prediction Reviews</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              Recently reviewed backtests with synced results — historical model evaluations, not future
              forecasts.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.latestReviews.map((card) => (
                <PredictionListCard key={card.slug} card={card} />
              ))}
            </div>
            <p className="mt-4 text-sm">
              <Link href="/prediction-accuracy" className="font-medium text-sports-green hover:underline">
                How accuracy is measured →
              </Link>
            </p>
          </section>
        )}
      </div>
    </>
  )
}
