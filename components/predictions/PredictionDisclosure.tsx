import {
  UNIVERSAL_DISCLAIMER,
  transparencyRows,
  type PredictionStatusMeta,
  type PublicMatchPrediction,
} from "@/lib/predictions/public-prediction"

/**
 * The transparency block (model, data through, generated, sealed, data source)
 * plus the universal disclaimer and any state-specific extra disclaimer. The
 * disclaimers are rendered at a readable size and contrast — never hidden or
 * shrunk.
 */
export function PredictionDisclosure({
  prediction,
  meta,
}: {
  prediction: PublicMatchPrediction
  meta: PredictionStatusMeta
}) {
  const rows = transparencyRows(prediction)
  const disclaimers = [UNIVERSAL_DISCLAIMER, ...meta.extraDisclaimers]

  return (
    <div className="space-y-4 border-t pt-4">
      <div>
        <h3 className="mb-2 text-sm font-semibold">About this prediction</h3>
        <dl className="space-y-1 text-xs text-muted-foreground">
          {rows.map((r) => (
            <div key={r.label} className="flex justify-between gap-4">
              <dt>{r.label}</dt>
              <dd className="text-right font-medium">{r.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="space-y-1.5">
        {disclaimers.map((d, i) => (
          <p key={i} className="text-sm text-muted-foreground">
            {d}
          </p>
        ))}
      </div>
    </div>
  )
}
