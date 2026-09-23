import type { PredictionReason } from "@/lib/model/prediction-artifact"

/**
 * The model's data reasons, rendered verbatim from the prediction artifact. Only
 * the human-readable `label` and `text` are shown — no internal debug fields
 * (code / value / comparisonValue / direction / source). Order is preserved.
 * DATA_COVERAGE is already a neutral sentence in the artifact and is not
 * re-framed as supporting either side.
 */
export function PredictionReasons({ reasons }: { reasons: PredictionReason[] }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Why the AI predicts this</h3>
      <ol className="space-y-2">
        {reasons.map((r, i) => (
          <li key={i} className="flex gap-3 text-sm">
            <span
              aria-hidden="true"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-bold text-secondary-foreground"
            >
              {i + 1}
            </span>
            <span>
              <span className="font-medium">{r.label}</span>
              <span className="text-muted-foreground"> — {r.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
