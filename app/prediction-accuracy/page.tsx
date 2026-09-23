import type { Metadata } from "next"
import Link from "next/link"
import { CheckCircle2, FlaskConical, ShieldCheck } from "lucide-react"
import { Breadcrumbs } from "@/components/Breadcrumbs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { JsonLd, breadcrumbJsonLd } from "@/lib/jsonld"
import { SITE_URL } from "@/lib/constants"
import { getAccuracyPageData } from "@/lib/predictions/public-pages"

export const metadata: Metadata = {
  title: "AI Prediction Accuracy & Track Record | AI Predictor",
  description:
    "How AI Predictor measures prediction accuracy — the official public record, historical backtest evaluation, and the full methodology.",
  alternates: { canonical: "/prediction-accuracy" },
  openGraph: {
    title: "AI Prediction Accuracy & Track Record | AI Predictor",
    description:
      "How AI Predictor measures prediction accuracy — the official public record, historical backtest evaluation, and the full methodology.",
  },
}

const breadcrumbs = [
  { name: "Home", url: "/" },
  { name: "Prediction Accuracy", url: "/prediction-accuracy" },
]

const officialRules = [
  {
    title: "Sealed before kickoff",
    description: "The prediction is locked and recorded before the match starts.",
  },
  {
    title: "Published before kickoff",
    description: "The prediction must be visible on the site ahead of kickoff to count.",
  },
  {
    title: "Result synced after the match",
    description: "The verified result is attached once available, and the outcome is scored.",
  },
  {
    title: "Backtests excluded",
    description: "Historical backtest evaluations are separate from the official record.",
  },
  {
    title: "Historical reconstructions permanently excluded",
    description: "Post-event reconstructions never count toward the official record.",
  },
]

const methodology = [
  { label: "Official locked accuracy", description: "Accuracy over the official public record." },
  { label: "Original model accuracy", description: "The raw model output before any manual adjustment." },
  { label: "Manually adjusted match count", description: "0" },
  { label: "Exact score accuracy", description: "Share of predicted scorelines that match exactly." },
  { label: "1X2 accuracy", description: "Share of home / draw / away outcomes predicted correctly." },
  { label: "Brier score", description: "Mean squared error of the predicted probabilities." },
  { label: "Log loss", description: "Logarithmic scoring of the predicted probabilities." },
]

export default function PredictionAccuracyPage() {
  const acc = getAccuracyPageData()

  const backtestStats = [
    { label: "1X2 accuracy", value: `${(acc.backtest.accuracy1X2 * 100).toFixed(0)}%` },
    { label: "Exact score accuracy", value: `${(acc.backtest.exactScoreAccuracy * 100).toFixed(1)}%` },
    { label: "Brier score", value: acc.backtest.brierScore.toFixed(4) },
    { label: "Log loss", value: acc.backtest.logLoss.toFixed(5) },
  ]

  return (
    <>
      <JsonLd data={breadcrumbJsonLd(breadcrumbs, SITE_URL)} />

      <div className="container mx-auto max-w-7xl px-4 py-12">
        <Breadcrumbs items={breadcrumbs} />

        {/* Official record hero */}
        <section className="rounded-2xl border bg-card p-8">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-sports-green" />
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Official Prediction Record</h1>
          </div>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            The official record tracks every sealed prediction once it is published before kickoff and
            compared against a synced result.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardDescription>Official predictions</CardDescription>
                <CardTitle className="text-3xl font-bold tabular-nums">
                  {acc.officialPredictionCount}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardDescription>Official accuracy</CardDescription>
                <CardTitle className="text-2xl font-bold">Not available yet</CardTitle>
                <p className="text-sm text-muted-foreground">
                  No official predictions have been published and scored in this phase.
                </p>
              </CardHeader>
            </Card>
          </div>
        </section>

        {/* Official record rules */}
        <section className="mt-12">
          <h2 className="mb-4 text-xl font-semibold tracking-tight">How the Official Record Works</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {officialRules.map((rule) => (
              <Card key={rule.title} className="h-full">
                <CardHeader>
                  <div className="mb-2 flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-sports-green" />
                    <CardTitle className="text-base">{rule.title}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{rule.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Historical backtest evaluation */}
        <section className="mt-12">
          <div className="mb-4 flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-sports-blue" />
            <h2 className="text-xl font-semibold tracking-tight">Historical Backtest Evaluation</h2>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {backtestStats.map((stat) => (
              <Card key={stat.label} className="text-center">
                <CardContent className="pt-6">
                  <div className="text-3xl font-bold tabular-nums">{stat.value}</div>
                  <div className="mt-1 text-sm text-muted-foreground">{stat.label}</div>
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Sample size: {acc.backtest.sampleSize} matches.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            These results are historical model evaluation metrics and are not the official public prediction
            record.
          </p>
        </section>

        {/* Methodology */}
        <section className="mt-12">
          <h2 className="mb-4 text-xl font-semibold tracking-tight">Accuracy Methodology</h2>
          <dl className="divide-y rounded-xl border bg-card">
            {methodology.map((item) => (
              <div key={item.label} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
                <dt className="font-medium">{item.label}</dt>
                <dd className="text-sm text-muted-foreground">{item.description}</dd>
              </div>
            ))}
          </dl>
        </section>

        <p className="mt-8 text-sm">
          <Link href="/premier-league" className="font-medium text-sports-green hover:underline">
            Explore Premier League predictions →
          </Link>
        </p>
      </div>
    </>
  )
}
