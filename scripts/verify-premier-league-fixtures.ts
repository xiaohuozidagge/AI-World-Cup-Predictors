/**
 * Read-only verification of the synced Premier League fixture snapshot and its
 * join against the prediction artifacts.
 *
 * This is the `football:pl:verify` gate. It asserts the things that a fixture
 * sync could silently break:
 *
 *   - exactly one PL competition, 20 teams, 380 fixtures;
 *   - every fixture joins to a prediction by the stable `provider_fixture_id`
 *     (embedded in the prediction slug), and vice-versa — no orphans;
 *   - FINISHED fixtures carry a complete non-negative integer full-time score,
 *     and non-FINISHED fixtures carry none;
 *   - manifest counts match the fixture status distribution;
 *   - no Champions League runtime data is present.
 *
 * No network I/O, no clock, no writes. Exits non-zero on any failure.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { loadLocalSnapshot } from "../lib/football/fixture-sync"
import { loadStaticConfig } from "../lib/football/static-config"
import type { Fixture, Team } from "../lib/supabase/types"
import type { PredictionArtifact } from "../lib/model/prediction-artifact"

const OUTPUT_DIR = join(process.cwd(), "data", "predictions", "premier-league", "2026-27")
const EXPECTED_FIXTURES = 380
const EXPECTED_TEAMS = 20

const errors: string[] = []
function fail(message: string): void {
  errors.push(message)
}

function slugFor(fixture: Fixture, teamsById: Map<string, Team>): string {
  const home = teamsById.get(fixture.home_team_id)?.slug ?? "home"
  const away = teamsById.get(fixture.away_team_id)?.slug ?? "away"
  return `${home}-vs-${away}-${fixture.provider_fixture_id}`
}

function main(): void {
  const snapshot = loadLocalSnapshot()
  const config = loadStaticConfig()
  const teamsById = new Map(snapshot.teams.map((t) => [t.id, t]))

  const plFixtures = snapshot.fixtures.filter((f) => f.competition_id === config.competitionId)
  const nonPl = snapshot.fixtures.length - plFixtures.length
  if (nonPl !== 0) fail(`expected 0 non-PL fixtures, found ${nonPl}`)
  if (plFixtures.length !== EXPECTED_FIXTURES) fail(`expected ${EXPECTED_FIXTURES} PL fixtures, found ${plFixtures.length}`)

  const teamSet = new Set<string>()
  for (const f of plFixtures) {
    teamSet.add(f.home_team_id)
    teamSet.add(f.away_team_id)
  }
  if (teamSet.size !== EXPECTED_TEAMS) fail(`expected ${EXPECTED_TEAMS} teams, found ${teamSet.size}`)

  // --- join fixtures <-> predictions by provider_fixture_id -----------------
  const predictionsPath = join(OUTPUT_DIR, "predictions.json")
  if (!existsSync(predictionsPath)) {
    fail("predictions.json missing")
  } else {
    const predictions = JSON.parse(readFileSync(predictionsPath, "utf8")) as PredictionArtifact[]
    if (predictions.length !== EXPECTED_FIXTURES) fail(`predictions.json holds ${predictions.length}, expected ${EXPECTED_FIXTURES}`)

    const predictionBySlug = new Map(predictions.map((p) => [p.slug, p]))
    const fixtureBySlug = new Map<string, Fixture>()

    for (const f of plFixtures) {
      const slug = slugFor(f, teamsById)
      fixtureBySlug.set(slug, f)
      const pred = predictionBySlug.get(slug)
      if (!pred) {
        fail(`fixture ${f.id} (${slug}) has no matching prediction`)
        continue
      }
      if (!pred.id.endsWith(`-${f.provider_fixture_id}`)) {
        fail(`prediction ${pred.id} does not embed provider_fixture_id ${f.provider_fixture_id}`)
      }
    }

    for (const p of predictions) {
      if (!fixtureBySlug.has(p.slug)) fail(`prediction ${p.id} (${p.slug}) has no matching fixture`)
    }
  }

  // --- status/score consistency ---------------------------------------------
  let finished = 0
  let notStarted = 0
  for (const f of plFixtures) {
    if (f.status === "FINISHED") {
      finished++
      if (
        !Number.isInteger(f.fulltime_home_score) ||
        !Number.isInteger(f.fulltime_away_score) ||
        (f.fulltime_home_score as number) < 0 ||
        (f.fulltime_away_score as number) < 0
      ) {
        fail(`fixture ${f.id} FINISHED but lacks a complete non-negative full-time score`)
      }
    } else {
      if (f.fulltime_home_score != null || f.fulltime_away_score != null) {
        fail(`fixture ${f.id} is ${f.status} but carries a full-time score`)
      }
      if (f.status === "SCHEDULED" || f.status === "TIMED") notStarted++
    }
  }

  // --- manifest counts -------------------------------------------------------
  const m = snapshot.manifest
  if (m.counts.fixtures !== plFixtures.length) fail(`manifest counts.fixtures ${m.counts.fixtures} != ${plFixtures.length}`)
  if (m.counts.finishedFixtures !== finished) fail(`manifest finishedFixtures ${m.counts.finishedFixtures} != ${finished}`)
  if (m.counts.scheduledFixtures !== notStarted) fail(`manifest scheduledFixtures ${m.counts.scheduledFixtures} != ${notStarted}`)

  const liveCount = plFixtures.length - finished - notStarted
  console.log(
    `Premier League fixtures verified: ${plFixtures.length} total ` +
      `(${finished} finished, ${notStarted} not started, ${liveCount} live/postponed/cancelled)`,
  )

  if (errors.length > 0) {
    console.error(`\nfootball:pl:verify FAILED with ${errors.length} error(s):`)
    for (const e of errors) console.error(`- ${e}`)
    process.exit(1)
  }
  console.log("football:pl:verify — all checks passed")
}

main()
