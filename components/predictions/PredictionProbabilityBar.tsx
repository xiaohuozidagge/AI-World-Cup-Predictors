import { cn } from "@/lib/utils"
import type { Result } from "@/lib/model/types"

interface PredictionProbabilityBarProps {
  homeLabel: string
  awayLabel: string
  homePct: number
  drawPct: number
  awayPct: number
  predictedResult: Result
}

const TONE_CLASS: Record<"home" | "draw" | "away", string> = {
  home: "bg-sports-green",
  draw: "bg-sports-gold/60",
  away: "bg-sports-blue",
}

function OutcomeColumn({
  label,
  pct,
  emphasized,
  tone,
}: {
  label: string
  pct: number
  emphasized: boolean
  tone: "home" | "draw" | "away"
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-center",
        emphasized ? "border-sports-green ring-1 ring-sports-green/40" : "border-border",
      )}
      aria-label={`${label}: ${pct}%`}
    >
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xl font-bold tabular-nums">{pct}%</div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className={cn("h-full", TONE_CLASS[tone])} style={{ width: `${pct}%` }} />
      </div>
      {emphasized && (
        <div className="mt-1 text-xs font-semibold text-sports-green">Predicted</div>
      )}
    </div>
  )
}

/**
 * The 1X2 probability display. Percentages are pre-rounded (largest-remainder,
 * summing to exactly 100%) and every value carries a text label, so colour is
 * never the only signal. The predicted outcome is emphasised with a ring plus an
 * explicit "Predicted" caption, not colour alone.
 */
export function PredictionProbabilityBar(props: PredictionProbabilityBarProps) {
  const { homeLabel, awayLabel, homePct, drawPct, awayPct, predictedResult } = props

  return (
    <div role="group" aria-label="Home, draw and away outcome probabilities">
      <div className="grid grid-cols-3 gap-3">
        <OutcomeColumn label={homeLabel} pct={homePct} emphasized={predictedResult === "H"} tone="home" />
        <OutcomeColumn label="Draw" pct={drawPct} emphasized={predictedResult === "D"} tone="draw" />
        <OutcomeColumn label={awayLabel} pct={awayPct} emphasized={predictedResult === "A"} tone="away" />
      </div>
    </div>
  )
}
