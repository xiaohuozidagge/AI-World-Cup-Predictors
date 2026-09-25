import type { StaticCompetitionStats as Stats } from "@/lib/football/static-queries"
import { formatUtcDate, formatUtcTime } from "@/lib/format-utc"

/**
 * Four stat tiles (Teams / Matches / Finished / Upcoming) plus an optional
 * "Next match" line. All values come from the database — nothing is hardcoded.
 */

const STAT_ITEMS = [
  { key: "teamCount", label: "Teams" },
  { key: "totalFixtures", label: "Matches" },
  { key: "finishedFixtures", label: "Finished" },
  { key: "upcomingFixtures", label: "Upcoming" },
] as const

export function CompetitionStats({ stats }: { stats: Stats }) {
  const values: Record<(typeof STAT_ITEMS)[number]["key"], number> = {
    teamCount: stats.teamCount,
    totalFixtures: stats.totalFixtures,
    finishedFixtures: stats.finishedFixtures,
    upcomingFixtures: stats.upcomingFixtures,
  }

  return (
    <div>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {STAT_ITEMS.map((item) => (
          <div key={item.key} className="rounded-xl border bg-card p-4 text-center shadow-sm">
            <dt className="text-xs font-medium text-muted-foreground">{item.label}</dt>
            <dd className="mt-1 text-2xl font-bold tabular-nums">{values[item.key]}</dd>
          </div>
        ))}
      </dl>
      {stats.nextMatchAt && (
        <p className="mt-3 text-sm text-muted-foreground">
          Next match: {formatUtcDate(stats.nextMatchAt)} · {formatUtcTime(stats.nextMatchAt)}
        </p>
      )}
    </div>
  )
}
