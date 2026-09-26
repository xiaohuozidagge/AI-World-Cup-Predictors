import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { formatUtcDate, formatUtcTime } from "@/lib/format-utc"
import { buildMatchUrl, matchContextLabel, type MatchCardFixture } from "@/lib/football/match-url"
import { TeamCrest } from "./TeamCrest"
import { MatchStatusBadge } from "./MatchStatusBadge"

/**
 * A single football fixture, without any prediction content. It shows the
 * kickoff date/time (UTC), the two teams (with their localized crest or a
 * monogram fallback), the current status, the stage or round, and — only for
 * finished matches — the full-time score.
 *
 * Unstarted matches never show a "0-0" and there is no predicted score or
 * win-probability anywhere on the card. When the fixture carries its provider
 * id and competition slug, the card also links through to the canonical match
 * detail page; otherwise the team names still link to `/clubs/[slug]`.
 */

export function MatchCard({ fixture }: { fixture: MatchCardFixture }) {
  const { kickoffAt, status, stage, matchweek, homeTeam, awayTeam, homeScore, awayScore } = fixture
  const hasScore = status === "FINISHED" && homeScore !== null && awayScore !== null
  const matchUrl =
    fixture.providerFixtureId != null && fixture.competitionSlug
      ? buildMatchUrl(
          {
            providerFixtureId: fixture.providerFixtureId,
            homeTeam: { slug: fixture.homeTeam.slug },
            awayTeam: { slug: fixture.awayTeam.slug },
          },
          fixture.competitionSlug,
        )
      : null

  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col p-5">
        <div className="mb-4 flex items-center justify-between gap-2">
          <MatchStatusBadge status={status} />
          <span className="text-xs font-medium text-muted-foreground">
            {matchContextLabel(stage, matchweek)}
          </span>
        </div>

        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <TeamCrest slug={homeTeam.slug} name={homeTeam.name} size="sm" />
            {homeTeam.slug ? (
              <Link href={`/clubs/${homeTeam.slug}`} className="truncate text-sm font-semibold hover:text-sports-green">
                {homeTeam.name}
              </Link>
            ) : (
              <span className="truncate text-sm font-semibold">{homeTeam.name}</span>
            )}
          </div>

          <div className="px-1 text-center">
            {hasScore ? (
              <span className="whitespace-nowrap text-lg font-bold tabular-nums">
                {homeScore} <span className="text-muted-foreground">–</span> {awayScore}
              </span>
            ) : (
              <span className="text-xs font-bold text-muted-foreground">vs</span>
            )}
          </div>

          <div className="flex min-w-0 items-center justify-end gap-2">
            {awayTeam.slug ? (
              <Link href={`/clubs/${awayTeam.slug}`} className="truncate text-sm font-semibold hover:text-sports-green">
                {awayTeam.name}
              </Link>
            ) : (
              <span className="truncate text-sm font-semibold">{awayTeam.name}</span>
            )}
            <TeamCrest slug={awayTeam.slug} name={awayTeam.name} size="sm" />
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <time dateTime={kickoffAt}>
            {formatUtcDate(kickoffAt)} · {formatUtcTime(kickoffAt)}
          </time>
          {matchUrl ? (
            <Link href={matchUrl} className="shrink-0 font-medium text-sports-green hover:underline">
              Match details
            </Link>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
