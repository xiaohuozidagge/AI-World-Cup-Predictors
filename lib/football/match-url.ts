import type { FixtureStatus } from "@/lib/supabase/types"

/**
 * Canonical match URL helpers (Phase 7).
 *
 * These are pure functions with no I/O, so they can be unit-tested in
 * isolation and used from both the query layer (server-only) and the pages.
 *
 * A match URL has the shape
 *
 *   /{competition-slug}/matches/{home-slug}-vs-{away-slug}-{provider-fixture-id}
 *
 * where the trailing `provider_fixture_id` is the only value that guarantees
 * uniqueness — a repeated matchup (Arsenal vs Liverpool, say) therefore never
 * collides, and the id alone is enough to look a fixture up. Team slugs are
 * already normalised to lowercase ASCII by the sync layer; we lower-case again
 * defensively.
 */

/** Minimal fixture shape needed to build a match URL. */
export interface MatchSlugInput {
  providerFixtureId: number
  homeTeam: { slug: string }
  awayTeam: { slug: string }
}

/**
 * The card/directory fixture shape shared between the existing league cards
 * (`MatchFixture` in `lib/football/queries.ts`) and the Phase 7 match data.
 * `providerFixtureId` and `competitionSlug` are optional so the pre-existing
 * card fixtures stay assignable; when both are present the card can link to the
 * canonical match detail URL.
 */
export interface MatchCardFixture {
  id: string
  providerFixtureId?: number
  competitionSlug?: string
  kickoffAt: string
  status: FixtureStatus
  stage: string | null
  matchweek: number | null
  homeTeam: { id: string; name: string; shortName: string | null; slug: string }
  awayTeam: { id: string; name: string; shortName: string | null; slug: string }
  homeScore: number | null
  awayScore: number | null
}

/** `{home}-vs-{away}-{id}`, all lower-case. */
export function buildMatchSlug(fixture: MatchSlugInput): string {
  const home = fixture.homeTeam.slug.toLowerCase()
  const away = fixture.awayTeam.slug.toLowerCase()
  return `${home}-vs-${away}-${fixture.providerFixtureId}`
}

/** A relative match URL such as `/premier-league/matches/arsenal-fc-vs-liverpool-fc-123456`. */
export function buildMatchUrl(fixture: MatchSlugInput, competitionSlug: string): string {
  return `/${competitionSlug}/matches/${buildMatchSlug(fixture)}`
}

/**
 * Extract the trailing numeric `provider_fixture_id` from a slug, or null when
 * the slug has no valid id (e.g. no trailing digits, or a non-numeric tail).
 * The id is always the final `-`-separated segment.
 */
export function parseFixtureIdFromSlug(slug: string): number | null {
  if (!slug) return null
  const trimmed = slug.trim()
  if (!trimmed) return null
  const last = trimmed.slice(trimmed.lastIndexOf("-") + 1)
  if (!/^\d+$/.test(last)) return null
  const n = Number(last)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** True when `requestedSlug` is exactly the canonical slug for the fixture. */
export function validateCanonicalMatchSlug(fixture: MatchSlugInput, requestedSlug: string): boolean {
  return requestedSlug === buildMatchSlug(fixture)
}

/**
 * Humanise a football-data.org stage string: `LEAGUE_STAGE` → `League Stage`.
 * Empty/null stages yield "".
 */
export function humanizeStage(stage: string | null): string {
  if (!stage) return ""
  return stage
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/**
 * The round label for a fixture: "Matchweek N" for a numbered round, falling
 * back to the humanised stage or "Fixture".
 */
export function matchContextLabel(stage: string | null, matchweek: number | null): string {
  if (matchweek != null) {
    return `Matchweek ${matchweek}`
  }
  return humanizeStage(stage) || "Fixture"
}

/**
 * Map a fixture status to a schema.org event status URI (for SportsEvent JSON-LD).
 * Returns null for states that have no clean schema.org equivalent, in which
 * case the `eventStatus` field is omitted.
 */
/** European season label from its start year: 2026 → "2026/27". */
export function seasonLabel(season: number): string {
  return `${season}/${String((season + 1) % 100).padStart(2, "0")}`
}

export function mapMatchEventStatus(status: FixtureStatus): string | null {
  switch (status) {
    case "SCHEDULED":
    case "TIMED":
      return "https://schema.org/EventScheduled"
    case "LIVE":
    case "HALFTIME":
      return "https://schema.org/EventInProgress"
    case "FINISHED":
      return "https://schema.org/EventCompleted"
    case "POSTPONED":
    case "SUSPENDED":
      return "https://schema.org/EventPostponed"
    case "CANCELLED":
      return "https://schema.org/EventCancelled"
  }
}
