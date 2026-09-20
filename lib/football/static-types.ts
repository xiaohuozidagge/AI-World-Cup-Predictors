/**
 * Types and constants for the static football-data snapshot
 * (`data/football/*.json`).
 *
 * These mirror the Supabase schema and are shared by the export and verification
 * scripts. The types are plain interfaces — they have no runtime dependency on
 * the Supabase client, so the static JSON can be read without importing any
 * server-only module.
 */
import type { FixtureStatus } from "../supabase/types"

/** Valid `fixture_status` enum values, mirroring `supabase/migrations/*.sql`. */
export const FIXTURE_STATUSES: readonly FixtureStatus[] = [
  "SCHEDULED",
  "TIMED",
  "LIVE",
  "HALFTIME",
  "FINISHED",
  "POSTPONED",
  "CANCELLED",
  "SUSPENDED",
]

/** Statuses for which a fixture has not kicked off and must carry no score. */
export const NOT_STARTED_STATUSES: readonly FixtureStatus[] = ["SCHEDULED", "TIMED"]

/** Statuses for which a fixture has finished and must carry a full-time score. */
export const FINISHED_STATUSES: readonly FixtureStatus[] = ["FINISHED"]

/** Per-competition entry in `manifest.json`. */
export interface CompetitionManifest {
  slug: string
  /** Raw DB season expression (e.g. `2026` for the 2026/27 season); never coerced to a string. */
  season: number | null
  teams: number
  fixtures: number
  finishedFixtures: number
  upcomingFixtures: number
}

/** Top-level structure of `data/football/manifest.json`. */
export interface StaticManifest {
  schemaVersion: number
  provider: string
  exportedAt: string
  sourceLastUpdatedAt: string | null
  counts: {
    competitions: number
    teams: number
    fixtures: number
    finishedFixtures: number
    scheduledFixtures: number
  }
  competitions: CompetitionManifest[]
}

export const STATIC_SCHEMA_VERSION = 1
