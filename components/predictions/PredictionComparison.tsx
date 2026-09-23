import { Badge } from "@/components/ui/badge"
import type { ComparisonOutcome, PredictionComparison as Comparison } from "@/lib/predictions/public-prediction"

const OUTCOME_LABEL: Record<ComparisonOutcome, string> = {
  exact: "Exact score matched",
  result: "Result matched",
  missed: "Prediction missed",
  pending: "Actual result available after the match",
  not_synced: "Result not yet synced",
}

const OUTCOME_VARIANT: Record<ComparisonOutcome, "success" | "info" | "warning" | "secondary"> = {
  exact: "success",
  result: "info",
  missed: "warning",
  pending: "secondary",
  not_synced: "secondary",
}

/**
 * Predicted-vs-actual comparison. When the match has a real score, a two-row
 * table (Score / Result) plus an outcome badge is shown; when it does not, the
 * badge carries the pending / not-synced message and no result is guessed.
 */
export function PredictionComparison({ comparison }: { comparison: Comparison }) {
  const hasRows = comparison.rows.length > 0

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Predicted vs actual</h3>

      <div className="mb-3">
        <Badge variant={OUTCOME_VARIANT[comparison.outcome]}>{OUTCOME_LABEL[comparison.outcome]}</Badge>
      </div>

      {hasRows ? (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="pb-1 font-normal"></th>
              <th scope="col" className="pb-1 font-normal">Predicted</th>
              <th scope="col" className="pb-1 text-right font-normal">Actual</th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((r) => (
              <tr key={r.label} className="border-t">
                <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted-foreground">
                  {r.label}
                </th>
                <td className="py-1.5 font-semibold tabular-nums">{r.predicted}</td>
                <td className="py-1.5 text-right font-semibold tabular-nums">{r.actual}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-muted-foreground">{comparison.note}</p>
      )}

      {hasRows && <p className="mt-3 text-xs text-muted-foreground">{comparison.note}</p>}
    </div>
  )
}
