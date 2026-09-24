import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { formatUtcDate, formatUtcTime } from "@/lib/format-utc"
import { buildMatchUrl, humanizeStage, matchContextLabel, seasonLabel } from "@/lib/football/match-url"
import type {
  FormEntry,
  HeadToHeadEntry,
  MatchDetailFixture,
  MatchPageData,
} from "@/lib/football/match-queries"
import { MatchStatusBadge } from "./MatchStatusBadge"
import { TeamCrest } from "./TeamCrest"

const OUTCOME_LABEL: Record<FormEntry["outcome"], string> = { W: "Win", D: "Draw", L: "Loss" }
const OUTCOME_CLASS: Record<FormEntry["outcome"], string> = {
  W: "bg-sports-green text-white",
  D: "bg-muted-foreground text-white",
  L: "bg-sports-gold text-white",
}

function OutcomePill({ outcome }: { outcome: FormEntry["outcome"] }) {
  return (
    <span
      aria-label={OUTCOME_LABEL[outcome]}
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold ${OUTCOME_CLASS[outcome]}`}
    >
      {outcome}
    </span>
  )
}

function TeamColumn({ name, slug, side }: { name: string; slug: string; side: "home" | "away" }) {
  const crest = <TeamCrest slug={slug} name={name} size="lg" priority />
  return (
    <div className={`flex min-w-0 flex-1 items-center gap-3 ${side === "away" ? "justify-end text-right" : ""}`}>
      {side === "home" && crest}
      <div className="min-w-0 flex-1">
        {slug ? (
          <Link href={`/clubs/${slug}`} className="block truncate text-base font-semibold hover:text-sports-green md:text-lg">
            {name}
          </Link>
        ) : (
          <span className="block truncate text-base font-semibold md:text-lg">{name}</span>
        )}
      </div>
      {side === "away" && crest}
    </div>
  )
}

function StatTable({ label, home, away }: { label: string; home: number; away: number }) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 py-1.5 text-sm">
      <span className="font-semibold tabular-nums">{home}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right font-semibold tabular-nums">{away}</span>
    </div>
  )
}

function FormList({ heading, entries }: { heading: string; entries: FormEntry[] }) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="text-base">{heading}</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No completed matches available before this fixture.</p>
        ) : (
          <ul className="space-y-2.5">
            {entries.map((e) => (
              <li key={e.fixtureId} className="flex items-center gap-2 text-sm">
                <OutcomePill outcome={e.outcome} />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">{e.isHome ? "vs" : "@"}</span> {e.opponent.name}
                  <span className="block text-xs text-muted-foreground">
                    {formatUtcDate(e.kickoffAt)} · {e.competitionName}
                  </span>
                </span>
                <span className="shrink-0 font-semibold tabular-nums">
                  {e.teamScore}–{e.opponentScore}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function RelatedRow({ fixture }: { fixture: MatchDetailFixture }) {
  const finished = fixture.status === "FINISHED" && fixture.homeScore != null && fixture.awayScore != null
  return (
    <Link
      href={buildMatchUrl(fixture, fixture.competitionSlug)}
      className="flex min-w-0 items-center gap-3 rounded-xl border bg-card p-3 text-sm shadow-sm transition-colors hover:border-sports-green"
    >
      <TeamCrest slug={fixture.homeTeam.slug} name={fixture.homeTeam.name} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">
          {fixture.homeTeam.name} vs {fixture.awayTeam.name}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {formatUtcDate(fixture.kickoffAt)} · {formatUtcTime(fixture.kickoffAt)}
        </span>
      </span>
      <TeamCrest slug={fixture.awayTeam.slug} name={fixture.awayTeam.name} size="sm" />
      <span className="shrink-0">
        {finished ? (
          <span className="font-semibold tabular-nums">
            {fixture.homeScore}–{fixture.awayScore}
          </span>
        ) : (
          <MatchStatusBadge status={fixture.status} />
        )}
      </span>
    </Link>
  )
}

export function MatchDetail({ data }: { data: MatchPageData }) {
  const { fixture, homeStats, awayStats, homeForm, awayForm, headToHead, related } = data
  const { competition, homeTeam, awayTeam } = fixture

  const hasScore = fixture.status === "FINISHED" && fixture.homeScore != null && fixture.awayScore != null
  const isLive = fixture.status === "LIVE" || fixture.status === "HALFTIME"
  const hasLiveScore = isLive && fixture.homeScore != null && fixture.awayScore != null
  const isNotStarted = fixture.status === "SCHEDULED" || fixture.status === "TIMED"

  const lastUpdated = fixture.sourceUpdatedAt ?? fixture.updatedAt

  return (
    <div className="space-y-10">
      {/* Hero */}
      <header>
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
          {homeTeam.name} vs {awayTeam.name}
        </h1>

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <Link href={`/${competition.slug}`} className="font-medium text-sports-green hover:underline">
            {competition.name}
          </Link>
          <span aria-hidden>·</span>
          <span>{matchContextLabel(fixture.stage, fixture.matchweek, competition.slug)}</span>
          <span aria-hidden>·</span>
          <time dateTime={fixture.kickoffAt}>
            {formatUtcDate(fixture.kickoffAt)} · {formatUtcTime(fixture.kickoffAt)}
          </time>
        </div>
      </header>

      {/* Score / status */}
      <Card>
        <CardContent className="p-6">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
            <TeamColumn name={homeTeam.name} slug={homeTeam.slug} side="home" />

            <div className="px-2 text-center">
              {hasScore ? (
                <div>
                  <div className="whitespace-nowrap text-3xl font-bold tabular-nums">
                    {fixture.homeScore} <span className="text-muted-foreground">–</span> {fixture.awayScore}
                  </div>
                  <div className="mt-1 text-sm font-semibold text-muted-foreground">Full-time</div>
                </div>
              ) : hasLiveScore ? (
                <div>
                  <div className="whitespace-nowrap text-3xl font-bold tabular-nums">
                    {fixture.homeScore} <span className="text-muted-foreground">–</span> {fixture.awayScore}
                  </div>
                  <div className="mt-2">
                    <MatchStatusBadge status={fixture.status} />
                  </div>
                </div>
              ) : isNotStarted ? (
                <div>
                  <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Kick-off</div>
                  <div className="mt-1 whitespace-nowrap text-sm font-semibold">
                    {formatUtcDate(fixture.kickoffAt)}
                  </div>
                  <div className="whitespace-nowrap text-sm font-semibold">{formatUtcTime(fixture.kickoffAt)}</div>
                </div>
              ) : (
                <MatchStatusBadge status={fixture.status} />
              )}
            </div>

            <TeamColumn name={awayTeam.name} slug={awayTeam.slug} side="away" />
          </div>
        </CardContent>
      </Card>

      {/* Match information */}
      <section aria-labelledby="match-information">
        <h2 id="match-information" className="mb-4 text-xl font-semibold tracking-tight">
          Match Information
        </h2>
        <Card>
          <CardContent className="p-6">
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              <div className="flex justify-between gap-4">
                <dt className="text-sm text-muted-foreground">Competition</dt>
                <dd className="text-sm font-medium">
                  <Link href={`/${competition.slug}`} className="hover:text-sports-green">
                    {competition.name}
                  </Link>
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-sm text-muted-foreground">Season</dt>
                <dd className="text-sm font-medium">{seasonLabel(fixture.season)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-sm text-muted-foreground">Stage</dt>
                <dd className="text-sm font-medium">{humanizeStage(fixture.stage) || "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-sm text-muted-foreground">
                  {competition.slug === "champions-league" ? "Matchday" : "Matchweek"}
                </dt>
                <dd className="text-sm font-medium">{fixture.matchweek ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-sm text-muted-foreground">Kick-off</dt>
                <dd className="text-sm font-medium">
                  {formatUtcDate(fixture.kickoffAt)} · {formatUtcTime(fixture.kickoffAt)}
                </dd>
              </div>
              {fixture.venueName && (
                <div className="flex justify-between gap-4">
                  <dt className="text-sm text-muted-foreground">Venue</dt>
                  <dd className="text-sm font-medium">{fixture.venueName}</dd>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <dt className="text-sm text-muted-foreground">Status</dt>
                <dd>
                  <MatchStatusBadge status={fixture.status} />
                </dd>
              </div>
              {lastUpdated && (
                <div className="flex justify-between gap-4">
                  <dt className="text-sm text-muted-foreground">Last updated</dt>
                  <dd className="text-sm font-medium">
                    {formatUtcDate(lastUpdated)} · {formatUtcTime(lastUpdated)}
                  </dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      </section>

      {/* Team comparison */}
      <section aria-labelledby="team-comparison">
        <h2 id="team-comparison" className="mb-4 text-xl font-semibold tracking-tight">
          Team Comparison
        </h2>
        <Card>
          <CardHeader>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center">
              <CardTitle className="truncate text-base">{homeTeam.name}</CardTitle>
              <span className="px-3 text-xs text-muted-foreground">Season record</span>
              <CardTitle className="truncate text-right text-base">{awayTeam.name}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <StatTable label="Played" home={homeStats.played} away={awayStats.played} />
            <StatTable label="Won" home={homeStats.won} away={awayStats.won} />
            <StatTable label="Drawn" home={homeStats.drawn} away={awayStats.drawn} />
            <StatTable label="Lost" home={homeStats.lost} away={awayStats.lost} />
            <StatTable label="Goals For" home={homeStats.goalsFor} away={awayStats.goalsFor} />
            <StatTable label="Goals Against" home={homeStats.goalsAgainst} away={awayStats.goalsAgainst} />
            <StatTable label="Goal Difference" home={homeStats.goalDifference} away={awayStats.goalDifference} />
          </CardContent>
        </Card>
      </section>

      {/* Recent form */}
      <section aria-labelledby="recent-form">
        <h2 id="recent-form" className="mb-4 text-xl font-semibold tracking-tight">
          Recent Form
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <FormList heading={homeTeam.name} entries={homeForm} />
          <FormList heading={awayTeam.name} entries={awayForm} />
        </div>
      </section>

      {/* Head-to-head */}
      <section aria-labelledby="head-to-head">
        <h2 id="head-to-head" className="mb-4 text-xl font-semibold tracking-tight">
          Head-to-Head
        </h2>
        <Card>
          <CardContent className="p-6">
            {headToHead.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No previous meetings are available in our current dataset.
              </p>
            ) : (
              <ul className="space-y-3">
                {headToHead.map((h: HeadToHeadEntry) => (
                  <li key={h.fixtureId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <time dateTime={h.kickoffAt} className="text-muted-foreground">
                      {formatUtcDate(h.kickoffAt)}
                    </time>
                    <span className="font-medium">
                      {h.homeTeam.name} {h.homeScore}–{h.awayScore} {h.awayTeam.name}
                    </span>
                    <span className="text-xs text-muted-foreground">{h.competitionName}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Related fixtures */}
      {related.length > 0 && (
        <section aria-labelledby="related-fixtures">
          <h2 id="related-fixtures" className="mb-4 text-xl font-semibold tracking-tight">
            Related Fixtures
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {related.map((f) => (
              <RelatedRow key={f.id} fixture={f} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
