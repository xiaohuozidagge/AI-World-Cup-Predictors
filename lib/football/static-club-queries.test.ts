import { test } from "node:test"
import assert from "node:assert/strict"

import {
  getStaticAllClubs,
  getStaticClubBySlug,
  getStaticClubFixtures,
  getStaticClubPageData,
  getStaticClubParams,
  getStaticClubsForSitemap,
} from "./static-club-queries"
import { teamFixturesIndex } from "./static-data"

const PL = "premier-league"

const clubs = getStaticAllClubs()
const bySlug = new Map(clubs.map((c) => [c.slug, c]))
const pageData = new Map(clubs.map((c) => [c.slug, getStaticClubPageData(c.slug)!]))

// (1) 20 clubs ----------------------------------------------------------------

test("getStaticAllClubs returns all 20 clubs", () => {
  assert.equal(clubs.length, 20)
})

// (2) unique slugs ------------------------------------------------------------

test("every club slug is unique", () => {
  assert.equal(new Set(clubs.map((c) => c.slug)).size, clubs.length)
})

// (3) generateStaticParams yields 20 unique slugs -----------------------------

test("getStaticClubParams yields 20 unique slugs matching the club list", () => {
  const params = getStaticClubParams()
  assert.equal(params.length, 20)
  assert.equal(new Set(params.map((p) => p.slug)).size, 20)
  assert.deepEqual(new Set(params.map((p) => p.slug)), new Set(clubs.map((c) => c.slug)))
})

// (4) memberships are the Premier League only ---------------------------------

test("every club belongs exclusively to the Premier League", () => {
  for (const club of clubs) {
    assert.equal(club.competitions.length, 1, `${club.slug} has ${club.competitions.length} memberships`)
    assert.equal(club.competitions[0].slug, PL, `${club.slug} is not Premier League`)
  }
})

// (5) all 20 clubs belong to the Premier League -------------------------------

test("all 20 clubs belong to the Premier League", () => {
  const pl = clubs.filter((c) => c.competitions.some((x) => x.slug === PL)).length
  assert.equal(pl, 20)
})

// (6) known slug resolves with a crest URL ------------------------------------

test("getStaticClubBySlug finds a club and carries its crest URL", () => {
  const sample = clubs[0]
  const club = getStaticClubBySlug(sample.slug)
  assert.ok(club)
  assert.equal(club.name, sample.name)
  assert.ok(club.logoUrl, `${sample.slug} is missing a crest URL`)
  assert.ok(club.logoUrl!.startsWith("https://"), `${sample.slug} crest URL is not https`)
})

// (7) unknown slug → null -----------------------------------------------------

test("getStaticClubBySlug returns null for an unknown slug", () => {
  assert.equal(getStaticClubBySlug("no-such-club"), null)
})

// (8) unknown slug → null page data -------------------------------------------

test("getStaticClubPageData returns null for an unknown slug", () => {
  assert.equal(getStaticClubPageData("no-such-club"), null)
})

// (9) known slug resolves full page data --------------------------------------

test("getStaticClubPageData resolves a known club with its name and memberships", () => {
  for (const club of clubs) {
    const data = pageData.get(club.slug)!
    assert.equal(data.club.name, club.name)
    assert.equal(data.competitions.length, club.competitions.length)
    assert.ok(data.club.id)
  }
})

// (10) fixtures reference the club as home or away ----------------------------

test("every club fixture references the club as home or away", () => {
  for (const club of clubs) {
    for (const f of getStaticClubFixtures(club.id)) {
      assert.ok(f.homeTeam.id === club.id || f.awayTeam.id === club.id, `${club.slug} has an unrelated fixture`)
    }
  }
})

// (11) club fixture count matches the snapshot index --------------------------

test("getStaticClubFixtures returns every fixture in the snapshot index", () => {
  for (const club of clubs) {
    const expected = (teamFixturesIndex.get(club.id) ?? []).length
    assert.equal(getStaticClubFixtures(club.id).length, expected)
  }
})

// (12) played === won + drawn + lost ------------------------------------------

test("every club's record satisfies played === won + drawn + lost", () => {
  for (const club of clubs) {
    const o = pageData.get(club.slug)!.stats.overall
    assert.equal(o.played, o.won + o.drawn + o.lost, club.slug)
  }
})

// (13) goalDifference === goalsFor - goalsAgainst -----------------------------

test("every club's record satisfies goalDifference === goalsFor - goalsAgainst", () => {
  for (const club of clubs) {
    const o = pageData.get(club.slug)!.stats.overall
    assert.equal(o.goalDifference, o.goalsFor - o.goalsAgainst, club.slug)
  }
})

// (14) upcoming is only SCHEDULED/TIMED ---------------------------------------

test("every club's upcoming fixtures are only SCHEDULED or TIMED", () => {
  for (const club of clubs) {
    for (const f of pageData.get(club.slug)!.upcoming) {
      assert.ok(f.status === "SCHEDULED" || f.status === "TIMED", `${club.slug} upcoming ${f.status}`)
    }
  }
})

// (15) recent is only FINISHED ------------------------------------------------

test("every club's recent results are only FINISHED", () => {
  for (const club of clubs) {
    for (const f of pageData.get(club.slug)!.recent) {
      assert.equal(f.status, "FINISHED", club.slug)
    }
  }
})

// (16) form is capped at the last 5 matches -----------------------------------

test("every club's recent form is capped at 5 outcomes", () => {
  for (const club of clubs) {
    assert.ok(pageData.get(club.slug)!.stats.overall.form.length <= 5, club.slug)
  }
})

// (17) sitemap covers all 20 clubs with unique slugs --------------------------

test("getStaticClubsForSitemap returns 20 entries with unique slugs", () => {
  const entries = getStaticClubsForSitemap()
  assert.equal(entries.length, 20)
  assert.equal(new Set(entries.map((e) => e.slug)).size, 20)
  for (const e of entries) {
    assert.ok(bySlug.has(e.slug), `sitemap slug ${e.slug} is not a known club`)
    if (e.lastModified != null) {
      assert.ok(!Number.isNaN(new Date(e.lastModified).getTime()), `bad lastModified for ${e.slug}`)
    }
  }
})
