import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { TeamCrest } from "@/components/football/TeamCrest"
import { formatUtcDate, formatUtcTime } from "@/lib/format-utc"
import { confidenceBadgeVariant } from "@/lib/predictions/prediction-ui"
import type { PredictionCard } from "@/lib/predictions/public-pages"

/**
 * Compact, reusable prediction card for the list pages (home, "today", Premier
 * League landing). Shows the two club crests, the matchup, kickoff, predicted
 * score, 1X2 percentages, confidence and status badge, and links to the match
 * detail page. When the match already has a synced result (a backtest review)
 * the actual score is shown beside the predicted score so a review can never be
 * mistaken for a future forecast.
 */
export function PredictionListCard({ card }: { card: PredictionCard }) {
  return (
    <Link href={card.url} className="group block">
      <article className="h-full rounded-xl border bg-card p-4 shadow-sm transition-colors hover:border-sports-green">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h3 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold leading-snug">
            <TeamCrest slug={card.homeSlug} name={card.homeName} size="sm" />
            <span className="min-w-0 truncate">{card.homeName}</span>
            <span className="shrink-0 font-normal text-muted-foreground">vs</span>
            <span className="min-w-0 truncate">{card.awayName}</span>
            <TeamCrest slug={card.awaySlug} name={card.awayName} size="sm" />
          </h3>
          <Badge variant={card.statusBadgeVariant} className="shrink-0">
            {card.statusLabel}
          </Badge>
        </div>

        <p className="mt-1 text-xs text-muted-foreground">
          {formatUtcDate(card.kickoffUtc)} · {formatUtcTime(card.kickoffUtc)}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="rounded-lg bg-secondary/40 px-3 py-2 text-center">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Predicted
            </div>
            <div className="text-xl font-bold tabular-nums">
              {card.predictedScore.home}
              <span className="mx-0.5 text-muted-foreground">–</span>
              {card.predictedScore.away}
            </div>
            {card.actualScore && (
              <div className="mt-1 text-[11px] text-muted-foreground">
                Actual{" "}
                <span className="font-semibold tabular-nums text-foreground">
                  {card.actualScore.home}–{card.actualScore.away}
                </span>
              </div>
            )}
          </div>

          <dl className="grid min-w-0 flex-1 grid-cols-3 gap-2 text-center">
            <div>
              <dt className="text-[11px] text-muted-foreground">Home</dt>
              <dd className="text-sm font-semibold tabular-nums">{card.percentages[0]}%</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Draw</dt>
              <dd className="text-sm font-semibold tabular-nums">{card.percentages[1]}%</dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Away</dt>
              <dd className="text-sm font-semibold tabular-nums">{card.percentages[2]}%</dd>
            </div>
          </dl>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2 text-xs">
          <Badge variant={confidenceBadgeVariant(card.confidenceLevel)}>{card.confidenceLabel}</Badge>
          <span className="font-medium text-sports-green group-hover:underline">View match analysis →</span>
        </div>
      </article>
    </Link>
  )
}
