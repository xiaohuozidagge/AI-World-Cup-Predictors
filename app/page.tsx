import type { Metadata } from "next"
import Link from "next/link"
import {
  ArrowRight,
  BarChart3,
  History,
  Lock,
  ShieldCheck,
  Trophy,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { JsonLd } from "@/lib/jsonld"
import { SITE_URL } from "@/lib/constants"
import { getHomePageData } from "@/lib/predictions/public-pages"
import { formatTransparencyDateTime } from "@/lib/predictions/public-prediction"
import { PredictionListCard } from "@/components/predictions/PredictionListCard"

export const metadata: Metadata = {
  title: "AI Football Predictions & Match Analysis | AI Predictor",
  description:
    "Explore AI football predictions, predicted scores, 1X2 probabilities and match analysis for the 2026/27 Premier League season.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "AI Football Predictions & Match Analysis | AI Predictor",
    description:
      "Explore AI football predictions, predicted scores, 1X2 probabilities and match analysis for the 2026/27 Premier League season.",
  },
}

const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "AI Predictor",
  url: SITE_URL,
}

const webPageJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: "AI Football Predictions & Match Analysis",
  url: SITE_URL,
  description:
    "Explore AI football predictions, predicted scores, 1X2 probabilities and match analysis for the 2026/27 Premier League season.",
  isPartOf: { "@type": "WebSite", name: "AI Predictor", url: SITE_URL },
}

const howItWorks = [
  {
    icon: History,
    title: "Historical match data",
    description: "The model trains on verified historical results and team statistics.",
  },
  {
    icon: BarChart3,
    title: "Statistical model",
    description: "A data-driven model estimates 1X2 probabilities and a predicted score for every fixture.",
  },
  {
    icon: Lock,
    title: "Sealed pre-match forecast",
    description: "Each prediction is sealed before kickoff so it can be verified against the real result.",
  },
]

export default function HomePage() {
  const data = getHomePageData()
  const snapshot = data.snapshot

  const snapshotStats = [
    { label: "Total fixtures", value: snapshot.totalFixtures },
    { label: "Sealed predictions", value: snapshot.sealedPredictions },
    { label: "Backtested matches", value: snapshot.originalBacktests },
    { label: "Historical reconstructions", value: snapshot.historicalReconstructions },
    { label: "Official results", value: snapshot.officialResults },
  ]

  return (
    <>
      <JsonLd data={websiteJsonLd} />
      <JsonLd data={webPageJsonLd} />

      {/* Hero */}
      <section className="border-b bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
        <div className="container mx-auto max-w-7xl px-4 py-16 md:py-24">
          <div className="mx-auto max-w-3xl text-center">
            <Badge variant="success" className="mb-4">
              2026/27 Premier League · Model v1.0.0
            </Badge>
            <h1 className="mb-6 text-4xl font-extrabold tracking-tight md:text-5xl lg:text-6xl">
              AI Football Predictions and Match Analysis
            </h1>
            <p className="mx-auto mb-8 max-w-2xl text-lg text-slate-300 md:text-xl">
              Explore data-driven score predictions, 1X2 probabilities and match analysis for the 2026/27
              Premier League season.
            </p>
            <div className="flex flex-col justify-center gap-3 sm:flex-row">
              <Link href="/football-predictions-today">
                <Button size="xl" className="w-full bg-sports-green hover:bg-sports-green/90 sm:w-auto">
                  View Today&apos;s Predictions <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
              <Link href="/premier-league">
                <Button
                  size="xl"
                  variant="outline"
                  className="w-full border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white sm:w-auto"
                >
                  Explore Premier League
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Upcoming Predictions */}
      <section className="container mx-auto max-w-7xl px-4 py-16">
        <div className="mb-8 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Upcoming Predictions</h2>
            <p className="mt-2 max-w-2xl text-muted-foreground">
              Sealed pre-match forecasts for the next Premier League matchday.
            </p>
          </div>
          <Link
            href="/football-predictions-today"
            className="hidden shrink-0 text-sm font-medium text-sports-green hover:underline sm:block"
          >
            View all predictions →
          </Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.upcoming.map((card) => (
            <PredictionListCard key={card.slug} card={card} />
          ))}
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Schedule data updated: {formatTransparencyDateTime(snapshot.scheduleUpdatedAt)}
        </p>
      </section>

      {/* How Predictions Work */}
      <section className="border-t bg-muted/30">
        <div className="container mx-auto max-w-7xl px-4 py-16">
          <div className="mb-8 text-center">
            <h2 className="text-3xl font-bold tracking-tight">How Predictions Work</h2>
            <p className="mx-auto mt-2 max-w-2xl text-muted-foreground">
              A transparent, three-step process from data to sealed forecast.
            </p>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            {howItWorks.map((step, i) => (
              <Card key={step.title} className="h-full">
                <CardHeader>
                  <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-sports-green/10 font-bold text-sports-green">
                    {i + 1}
                  </div>
                  <step.icon className="mb-1 h-6 w-6 text-sports-blue" />
                  <CardTitle>{step.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{step.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-muted-foreground">
            Predictions are statistical estimates and do not guarantee results. A “sealed” prediction is
            locked before kickoff and remains unmodified so it can be checked against the outcome.
          </p>
        </div>
      </section>

      {/* Season Snapshot */}
      <section className="container mx-auto max-w-7xl px-4 py-16">
        <div className="mb-8 text-center">
          <h2 className="text-3xl font-bold tracking-tight">2026/27 Season Snapshot</h2>
          <p className="mx-auto mt-2 max-w-2xl text-muted-foreground">
            A summary of the Premier League predictions currently available on the site.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {snapshotStats.map((stat) => (
            <Card key={stat.label} className="text-center">
              <CardContent className="pt-6">
                <div className="text-3xl font-bold tabular-nums">{stat.value}</div>
                <div className="mt-1 text-sm text-muted-foreground">{stat.label}</div>
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          The official public prediction record has not started yet — 0 results are currently tracked.
        </p>
      </section>

      {/* Accuracy Transparency */}
      <section className="border-t bg-muted/30">
        <div className="container mx-auto max-w-7xl px-4 py-16">
          <Card className="mx-auto max-w-3xl">
            <CardHeader className="text-center">
              <ShieldCheck className="mx-auto mb-2 h-10 w-10 text-sports-green" />
              <CardTitle className="text-2xl">Accuracy Transparency</CardTitle>
              <CardDescription>
                We publish our methodology and track record so you can judge the model for yourself.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center">
              <p className="text-sm text-muted-foreground">
                See how accuracy is measured, what is included in the official record, and the historical
                backtest evaluation.
              </p>
              <Link href="/prediction-accuracy" className="mt-4 inline-block">
                <Button variant="secondary">
                  View Prediction Accuracy <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Competitions */}
      <section className="container mx-auto max-w-7xl px-4 py-16">
        <div className="mb-8 text-center">
          <h2 className="text-3xl font-bold tracking-tight">Competitions</h2>
          <p className="mx-auto mt-2 max-w-2xl text-muted-foreground">
            AI predictions for the Premier League, plus our archived World Cup coverage.
          </p>
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <Link href="/premier-league" className="group">
            <Card className="h-full transition-shadow hover:shadow-md">
              <CardHeader>
                <div className="mb-2 flex items-center justify-between">
                  <Trophy className="h-8 w-8 text-sports-green" />
                  <Badge variant="success">Predictions Available</Badge>
                </div>
                <CardTitle className="group-hover:text-sports-green">Premier League 2026/27</CardTitle>
                <CardDescription>
                  Sealed match predictions, 1X2 probabilities and predicted scores for every Premier League
                  fixture.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <span className="inline-flex items-center gap-1 text-sm font-medium text-sports-green">
                  Explore Premier League{" "}
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </span>
              </CardContent>
            </Card>
          </Link>

          <Link href="/world-cup/2026" className="group">
            <Card className="h-full transition-shadow hover:shadow-md">
              <CardHeader>
                <div className="mb-2 flex items-center justify-between">
                  <Trophy className="h-8 w-8 text-sports-blue" />
                  <Badge variant="secondary">Archive</Badge>
                </div>
                <CardTitle className="group-hover:text-sports-green">World Cup Prediction Archive</CardTitle>
                <CardDescription>
                  Explore archived World Cup match predictions, results and team pages.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <span className="inline-flex items-center gap-1 text-sm font-medium text-sports-green">
                  View archive{" "}
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </span>
              </CardContent>
            </Card>
          </Link>
        </div>
      </section>
    </>
  )
}
