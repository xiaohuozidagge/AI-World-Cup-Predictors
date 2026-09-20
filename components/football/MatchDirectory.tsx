import Link from "next/link"
import { Activity, Ban, CalendarDays, Clock } from "lucide-react"
import { humanizeStage } from "@/lib/football/match-url"
import {
  filterFixtures,
  partitionFixtures,
  paginate,
  type MatchDirectoryData,
  type MatchDirectoryFilter,
} from "@/lib/football/match-logic"
import type { MatchCardFixture } from "@/lib/football/match-url"
import { FixtureList } from "./FixtureList"

const PAGE_SIZE = 30

export type MatchDirectoryView = "overview" | "in-progress" | "upcoming" | "results" | "other"

interface MatchDirectoryProps {
  data: MatchDirectoryData
  view: MatchDirectoryView
  page: number
  filter: MatchDirectoryFilter
  nowIso: string
}

function FilterLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`inline-flex items-center rounded-md border px-3 py-1 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active
          ? "border-sports-green bg-sports-green text-white"
          : "border-input bg-card hover:border-sports-green hover:text-sports-green"
      }`}
    >
      {children}
    </Link>
  )
}

function Pager({
  hrefFor,
  page,
  totalPages,
  label,
}: {
  hrefFor: (p: number) => string
  page: number
  totalPages: number
  label: string
}) {
  if (totalPages <= 1) return null
  return (
    <nav aria-label={`${label} pagination`} className="mt-6 flex items-center justify-between gap-2">
      {page > 1 ? (
        <Link
          href={hrefFor(page - 1)}
          className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:border-sports-green hover:text-sports-green"
        >
          Previous
        </Link>
      ) : (
        <span aria-hidden className="px-3 py-1.5" />
      )}
      <span className="text-sm text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      {page < totalPages ? (
        <Link
          href={hrefFor(page + 1)}
          className="rounded-md border border-input bg-card px-3 py-1.5 text-sm font-medium hover:border-sports-green hover:text-sports-green"
        >
          Next
        </Link>
      ) : (
        <span aria-hidden className="px-3 py-1.5" />
      )}
    </nav>
  )
}

function GroupHeading({
  icon: Icon,
  title,
  href,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  title: string
  href?: string
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <Icon className="h-5 w-5 text-sports-green" aria-hidden />
        {title}
      </h2>
      {href && (
        <Link href={href} className="text-sm font-medium text-sports-green hover:underline">
          View all
        </Link>
      )}
    </div>
  )
}

function Section({
  title,
  icon: Icon,
  items,
  emptyMessage,
  viewName,
  page,
  hrefFor,
}: {
  title: string
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  items: MatchCardFixture[]
  emptyMessage: string
  viewName: Exclude<MatchDirectoryView, "overview">
  page: number
  hrefFor: (v: MatchDirectoryView, p: number) => string
}) {
  if (items.length === 0) {
    return (
      <section aria-labelledby={`${viewName}-heading`}>
        <h2 id={`${viewName}-heading`} className="mb-3 flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Icon className="h-5 w-5 text-sports-green" aria-hidden />
          {title}
        </h2>
        <p className="rounded-xl border bg-muted/30 px-6 py-8 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      </section>
    )
  }

  const slice = paginate(items, page, PAGE_SIZE)
  return (
    <section aria-labelledby={`${viewName}-heading`}>
      <GroupHeading icon={Icon} title={title} />
      <FixtureList fixtures={slice.items} emptyMessage={emptyMessage} />
      <Pager hrefFor={(p) => hrefFor(viewName, p)} page={slice.page} totalPages={slice.totalPages} label={title} />
    </section>
  )
}

export function MatchDirectory({ data, view, page, filter, nowIso }: MatchDirectoryProps) {
  const { competition, fixtures, filterOptions } = data
  const basePath = `/${competition.slug}/matches`
  const isCL = competition.slug === "champions-league"
  const roundLabel = isCL ? "Matchday" : "Matchweek"

  const filtered = filterFixtures(fixtures, filter)
  const { inProgress, upcoming, results, other } = partitionFixtures(filtered, nowIso)

  const hrefFor = (v: MatchDirectoryView, p: number): string => {
    const params = new URLSearchParams()
    if (filter.matchweek != null) params.set("matchweek", String(filter.matchweek))
    if (filter.stage != null) params.set("stage", filter.stage)
    if (v !== "overview") params.set("view", v)
    if (p > 1) params.set("page", String(p))
    const qs = params.toString()
    return qs ? `${basePath}?${qs}` : basePath
  }

  const filterHref = (matchweek: number | null, stage: string | null): string => {
    const params = new URLSearchParams()
    if (matchweek != null) params.set("matchweek", String(matchweek))
    if (stage != null) params.set("stage", stage)
    const qs = params.toString()
    return qs ? `${basePath}?${qs}` : basePath
  }

  const overview = (view === "overview")
  const showOverview = (list: unknown[]): boolean => overview && list.length > 0

  return (
    <div className="space-y-10">
      {/* Round / stage filters */}
      <section aria-label="Filter fixtures" className="space-y-4">
        {filterOptions.stages.length > 1 && (
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Stage</div>
            <div className="flex flex-wrap gap-2">
              <FilterLink href={filterHref(filter.matchweek, null)} active={filter.stage == null}>
                All stages
              </FilterLink>
              {filterOptions.stages.map((st) => (
                <FilterLink key={st} href={filterHref(filter.matchweek, st)} active={filter.stage === st}>
                  {humanizeStage(st)}
                </FilterLink>
              ))}
            </div>
          </div>
        )}
        {filterOptions.matchweeks.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{roundLabel}</div>
            <div className="flex flex-wrap gap-2">
              <FilterLink href={filterHref(null, filter.stage)} active={filter.matchweek == null}>
                All
              </FilterLink>
              {filterOptions.matchweeks.map((mw) => (
                <FilterLink key={mw} href={filterHref(mw, filter.stage)} active={filter.matchweek === mw}>
                  {mw}
                </FilterLink>
              ))}
            </div>
          </div>
        )}
      </section>

      {view === "in-progress" && (
        <Section
          title="In Progress"
          icon={Activity}
          items={inProgress}
          emptyMessage="No matches are currently in progress."
          viewName="in-progress"
          page={page}
          hrefFor={hrefFor}
        />
      )}

      {view === "upcoming" && (
        <Section
          title="Upcoming Fixtures"
          icon={CalendarDays}
          items={upcoming}
          emptyMessage="No upcoming fixtures match this filter."
          viewName="upcoming"
          page={page}
          hrefFor={hrefFor}
        />
      )}

      {view === "results" && (
        <Section
          title="Recent Results"
          icon={Clock}
          items={results}
          emptyMessage="No completed matches match this filter."
          viewName="results"
          page={page}
          hrefFor={hrefFor}
        />
      )}

      {view === "other" && (
        <Section
          title="Postponed & Cancelled"
          icon={Ban}
          items={other}
          emptyMessage="No postponed or cancelled matches match this filter."
          viewName="other"
          page={page}
          hrefFor={hrefFor}
        />
      )}

      {overview && (
        <>
          {showOverview(inProgress) && (
            <section aria-labelledby="in-progress-heading">
              <GroupHeading icon={Activity} title="In Progress" href={hrefFor("in-progress", 1)} />
              <FixtureList fixtures={inProgress} emptyMessage="No matches are currently in progress." />
            </section>
          )}

          {showOverview(upcoming) && (
            <section aria-labelledby="upcoming-heading">
              <GroupHeading
                icon={CalendarDays}
                title="Upcoming Fixtures"
                href={upcoming.length > PAGE_SIZE ? hrefFor("upcoming", 1) : undefined}
              />
              <FixtureList
                fixtures={upcoming.slice(0, PAGE_SIZE)}
                emptyMessage="No upcoming fixtures are currently available."
              />
            </section>
          )}

          {showOverview(results) && (
            <section aria-labelledby="results-heading">
              <GroupHeading
                icon={Clock}
                title="Recent Results"
                href={results.length > PAGE_SIZE ? hrefFor("results", 1) : undefined}
              />
              <FixtureList
                fixtures={results.slice(0, PAGE_SIZE)}
                emptyMessage="No completed matches are currently available."
              />
            </section>
          )}

          {showOverview(other) && (
            <section aria-labelledby="other-heading">
              <GroupHeading
                icon={Ban}
                title="Postponed & Cancelled"
                href={other.length > PAGE_SIZE ? hrefFor("other", 1) : undefined}
              />
              <FixtureList fixtures={other.slice(0, PAGE_SIZE)} emptyMessage="No postponed or cancelled matches." />
            </section>
          )}

          {inProgress.length === 0 && upcoming.length === 0 && results.length === 0 && other.length === 0 && (
            <p className="rounded-xl border bg-muted/30 px-6 py-10 text-center text-sm text-muted-foreground">
              No fixtures match this filter.
            </p>
          )}
        </>
      )}
    </div>
  )
}
