import { test } from "node:test"
import assert from "node:assert/strict"

import {
  buildMatchSlug,
  buildMatchUrl,
  parseFixtureIdFromSlug,
  validateCanonicalMatchSlug,
  humanizeStage,
  matchContextLabel,
  mapMatchEventStatus,
  seasonLabel,
  type MatchSlugInput,
} from "./match-url"

function fixture(home: string, away: string, id: number): MatchSlugInput {
  return { providerFixtureId: id, homeTeam: { slug: home }, awayTeam: { slug: away } }
}

test("builds a normal slug and URL", () => {
  const f = fixture("arsenal-fc", "liverpool-fc", 123456)
  assert.equal(buildMatchSlug(f), "arsenal-fc-vs-liverpool-fc-123456")
  assert.equal(buildMatchUrl(f, "premier-league"), "/premier-league/matches/arsenal-fc-vs-liverpool-fc-123456")
})

test("lower-cases slug components", () => {
  const f = fixture("Real-Madrid-CF", "FC-Barcelona", 555)
  assert.equal(buildMatchSlug(f), "real-madrid-cf-vs-fc-barcelona-555")
})

test("preserves hyphens inside team slugs and still parses the id", () => {
  const f = fixture("west-bromwich-albion", "brighton-hove-albion", 999888)
  const slug = buildMatchSlug(f)
  assert.equal(slug, "west-bromwich-albion-vs-brighton-hove-albion-999888")
  assert.equal(parseFixtureIdFromSlug(slug), 999888)
})

test("repeated matchups get distinct slugs and distinct ids", () => {
  const a = buildMatchSlug(fixture("arsenal-fc", "liverpool-fc", 111))
  const b = buildMatchSlug(fixture("arsenal-fc", "liverpool-fc", 222))
  assert.notEqual(a, b)
  assert.equal(parseFixtureIdFromSlug(a), 111)
  assert.equal(parseFixtureIdFromSlug(b), 222)
})

test("unparseable id (no trailing digits) returns null", () => {
  assert.equal(parseFixtureIdFromSlug("arsenal-fc-vs-liverpool-fc"), null)
  assert.equal(parseFixtureIdFromSlug("arsenal-fc-vs-liverpool-fc-"), null)
  assert.equal(parseFixtureIdFromSlug(""), null)
})

test("non-numeric id returns null", () => {
  assert.equal(parseFixtureIdFromSlug("arsenal-fc-vs-liverpool-fc-abc"), null)
  assert.equal(parseFixtureIdFromSlug("arsenal-fc-vs-liverpool-fc-12a34"), null)
})

test("wrong slug with correct id is detected as non-canonical", () => {
  const f = fixture("arsenal-fc", "liverpool-fc", 123456)
  // wrong text, correct id
  assert.equal(validateCanonicalMatchSlug(f, "man-utd-vs-chelsea-fc-123456"), false)
  assert.equal(parseFixtureIdFromSlug("man-utd-vs-chelsea-fc-123456"), 123456)
  // correct slug
  assert.equal(validateCanonicalMatchSlug(f, "arsenal-fc-vs-liverpool-fc-123456"), true)
})

test("humanizes stage strings", () => {
  assert.equal(humanizeStage("LEAGUE_STAGE"), "League Stage")
  assert.equal(humanizeStage("REGULAR_SEASON"), "Regular Season")
  assert.equal(humanizeStage(null), "")
})

test("context label is Matchweek N for a numbered round, else the humanised stage", () => {
  assert.equal(matchContextLabel("REGULAR_SEASON", 5), "Matchweek 5")
  assert.equal(matchContextLabel("LEAGUE_STAGE", 3), "Matchweek 3")
  assert.equal(matchContextLabel(null, null), "Fixture")
  assert.equal(matchContextLabel("ROUND_OF_16", null), "Round Of 16")
})

test("maps fixture status to schema.org event status", () => {
  assert.equal(mapMatchEventStatus("SCHEDULED"), "https://schema.org/EventScheduled")
  assert.equal(mapMatchEventStatus("TIMED"), "https://schema.org/EventScheduled")
  assert.equal(mapMatchEventStatus("LIVE"), "https://schema.org/EventInProgress")
  assert.equal(mapMatchEventStatus("HALFTIME"), "https://schema.org/EventInProgress")
  assert.equal(mapMatchEventStatus("FINISHED"), "https://schema.org/EventCompleted")
  assert.equal(mapMatchEventStatus("POSTPONED"), "https://schema.org/EventPostponed")
  assert.equal(mapMatchEventStatus("SUSPENDED"), "https://schema.org/EventPostponed")
  assert.equal(mapMatchEventStatus("CANCELLED"), "https://schema.org/EventCancelled")
})

test("seasonLabel formats a start year as a European season", () => {
  assert.equal(seasonLabel(2026), "2026/27")
  assert.equal(seasonLabel(2024), "2024/25")
  assert.equal(seasonLabel(1999), "1999/00")
})
