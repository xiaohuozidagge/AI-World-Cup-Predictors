import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { ConfidenceLevel } from "@/lib/model/types"
import {
  buildComparison,
  confidenceExplanation,
  confidenceLabel,
  largestRemainderPercentages,
  predictionStatusMeta,
  resultLabel,
  type PublicMatchPrediction,
} from "@/lib/predictions/public-prediction"
import { PredictionComparison } from "./PredictionComparison"
import { PredictionDisclosure } from "./PredictionDisclosure"
import { PredictionProbabilityBar } from "./PredictionProbabilityBar"
import { PredictionReasons } from "./PredictionReasons"

const CONFIDENCE_VARIANT: Record<ConfidenceLevel, "secondary" | "info" | "success"> = {
  low: "secondary",
  medium: "info",
  high: "success",
}

/**
 * The prediction module for a single Premier League match detail page. It shows
 * the sealed AI predicted score, 1X2 probabilities, predicted result, confidence,
 * the model's reasons, the top-3 scorelines, the predicted-vs-actual comparison,
 * and the transparency + disclaimer block. The predicted score is always labelled
 * "AI Predicted Score" so it can never be mistaken for the real score.
 */
export function MatchPredictionCard({ prediction }: { prediction: PublicMatchPrediction }) {
  const meta = predictionStatusMeta(prediction.status)
  const [homePct, drawPct, awayPct] = largestRemainderPercentages(
    prediction.probabilities.home,
    prediction.probabilities.draw,
    prediction.probabilities.away,
  )
  const comparison = buildComparison(prediction)
  const homeName = prediction.homeTeam.name
  const awayName = prediction.awayTeam.name
  const homeShort = prediction.homeTeam.shortName ?? homeName
  const awayShort = prediction.awayTeam.shortName ?? awayName

  return (
    <section aria-labelledby="ai-prediction" className="space-y-4">
      <h2 id="ai-prediction" className="text-xl font-semibold tracking-tight">
        AI Prediction
      </h2>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">AI Prediction</CardTitle>
            <Badge variant={meta.badgeVariant}>{meta.label}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{meta.description}</p>
        </CardHeader>

        <CardContent className="space-y-8">
          {/* AI Predicted Score */}
          <div>
            <div className="rounded-lg bg-secondary/40 p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                AI Predicted Score
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 text-base font-semibold">{homeName}</span>
                <span className="whitespace-nowrap text-3xl font-bold tabular-nums">
                  {prediction.predictedScore.home}
                  <span className="mx-1 text-muted-foreground">–</span>
                  {prediction.predictedScore.away}
                </span>
                <span className="min-w-0 flex-1 text-right text-base font-semibold">{awayName}</span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="outline">{resultLabel(prediction.predictedResult)}</Badge>
                <span className="text-muted-foreground">Model v{prediction.modelVersion}</span>
                <Badge variant={CONFIDENCE_VARIANT[prediction.confidence.level]}>
                  {confidenceLabel(prediction.confidence.level)}
                </Badge>
              </div>
            </div>
          </div>

          {/* 1X2 probabilities */}
          <div>
            <h3 className="mb-3 text-sm font-semibold">Home / Draw / Away probabilities</h3>
            <PredictionProbabilityBar
              homeLabel={homeShort}
              awayLabel={awayShort}
              homePct={homePct}
              drawPct={drawPct}
              awayPct={awayPct}
              predictedResult={prediction.predictedResult}
            />
          </div>

          {/* Confidence */}
          <div>
            <h3 className="mb-2 text-sm font-semibold">Confidence</h3>
            <p className="text-sm">
              <span className="font-medium">{confidenceLabel(prediction.confidence.level)}</span>
              <span className="text-muted-foreground"> — {confidenceExplanation(prediction.confidence.level)}</span>
            </p>
          </div>

          {/* Reasons */}
          <PredictionReasons reasons={prediction.reasons} />

          {/* Top scorelines */}
          <div>
            <h3 className="mb-2 text-sm font-semibold">Top scorelines</h3>
            <ul className="space-y-1.5">
              {prediction.topScorelines.map((s, i) => (
                <li key={i} className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-semibold tabular-nums">
                    {s.home}–{s.away}
                  </span>
                  <span className="text-muted-foreground">{(s.probability * 100).toFixed(1)}%</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Predicted vs actual */}
          <PredictionComparison comparison={comparison} />

          {/* Transparency + disclaimer */}
          <PredictionDisclosure prediction={prediction} meta={meta} />
        </CardContent>
      </Card>
    </section>
  )
}
