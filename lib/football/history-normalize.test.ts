import { test } from "node:test"
import assert from "node:assert/strict"

import { buildE0HeaderMap } from "./history-csv"
import {
  buildMatchId,
  normalizeMatch,
  normalizeSeason,
  parseScoreCell,
  resultFromScore,
  type TeamAliases,
} from "./history-normalize"

const HEADER = ["Div", "Date", "Time", "HomeTeam", "AwayTeam", "FTHG", "FTAG", "FTR", "HTHG", "HTAG", "HTR"]
const map = buildE0HeaderMap(HEADER)

const ALIASES: TeamAliases = {
  Arsenal: { canonicalName: "Arsenal FC", slug: "arsenal-fc" },
  Chelsea: { canonicalName: "Chelsea FC", slug: "chelsea-fc" },
  "Man City": { canonicalName: "Manchester City FC", slug: "manchester-city-fc" },
  "Man United": { canonicalName: "Manchester United FC", slug: "manchester-united-fc" },
}

// Row cells are ordered to match HEADER.
function row(
  home: string,
  away: string,
  fthg: string,
  ftag: string,
  ftr: string,
  opts: { date?: string; time?: string; hthg?: string; htag?: string; htr?: string } = {},
): string[] {
  return [
    "E0",
    opts.date ?? "13/08/2021",
    opts.time ?? "20:00",
    home,
    away,
    fthg,
    ftag,
    ftr,
    opts.hthg ?? "0",
    opts.htag ?? "0",
    opts.htr ?? "D",
  ]
}

// --- resultFromScore ----------------------------------------------------

test("resultFromScore derives H / D / A", () => {
  assert.equal(resultFromScore(2, 0), "H")
  assert.equal(resultFromScore(1, 1), "D")
  assert.equal(resultFromScore(0, 2), "A")
})

// --- buildMatchId -------------------------------------------------------

test("buildMatchId is deterministic and encodes season, slugs, and date", () => {
  assert.equal(buildMatchId("2021-22", "arsenal-fc", "chelsea-fc", "2021-08-22"), "pl-2021-22-arsenal-fc-vs-chelsea-fc-2021-08-22")
})

// --- parseScoreCell -----------------------------------------------------

test("parseScoreCell returns non-negative ints, null for blank, throws on garbage", () => {
  assert.equal(parseScoreCell("3"), 3)
  assert.equal(parseScoreCell("0"), 0)
  assert.equal(parseScoreCell(""), null)
  assert.equal(parseScoreCell(null), null)
  assert.throws(() => parseScoreCell("-1"))
  assert.throws(() => parseScoreCell("1.5"))
  assert.throws(() => parseScoreCell("abc"))
})

// --- normalizeMatch -----------------------------------------------------

test("normalizeMatch maps aliases, parses scores, and omits odds fields", () => {
  const m = normalizeMatch(row("Arsenal", "Chelsea", "2", "1", "H"), map, "2021-22", ALIASES)
  assert.equal(m.id, "pl-2021-22-arsenal-fc-vs-chelsea-fc-2021-08-13")
  assert.equal(m.competition, "premier-league")
  assert.equal(m.season, "2021-22")
  assert.equal(m.date, "2021-08-13")
  assert.equal(m.kickoffTimeLocal, "20:00")
  assert.deepEqual(m.homeTeam, { sourceName: "Arsenal", canonicalName: "Arsenal FC", slug: "arsenal-fc" })
  assert.deepEqual(m.awayTeam, { sourceName: "Chelsea", canonicalName: "Chelsea FC", slug: "chelsea-fc" })
  assert.deepEqual(m.fullTime, { home: 2, away: 1, result: "H" })
  assert.deepEqual(m.halfTime, { home: 0, away: 0, result: "D" })

  // No odds fields leak into the normalized shape.
  assert.deepEqual(Object.keys(m).sort(), [
    "awayTeam",
    "competition",
    "date",
    "fullTime",
    "halfTime",
    "homeTeam",
    "id",
    "kickoffTimeLocal",
    "season",
  ])
})

test("normalizeMatch derives FTR when the CSV result cell is blank", () => {
  const m = normalizeMatch(row("Man City", "Man United", "0", "2", ""), map, "2021-22", ALIASES)
  assert.equal(m.fullTime.result, "A")
})

test("normalizeMatch throws on an unmapped team name", () => {
  assert.throws(
    () => normalizeMatch(row("Arsenal", "No Such Team", "1", "0", "H"), map, "2021-22", ALIASES),
    /unmapped team name/,
  )
})

test("normalizeMatch throws on a negative score", () => {
  assert.throws(() => normalizeMatch(row("Arsenal", "Chelsea", "-1", "0", "H"), map, "2021-22", ALIASES), /invalid score cell/)
})

test("normalizeMatch throws on an invalid date", () => {
  assert.throws(
    () => normalizeMatch(row("Arsenal", "Chelsea", "1", "0", "H", { date: "30/02/2021" }), map, "2021-22", ALIASES),
    /invalid E0 date/,
  )
})

test("normalizeMatch throws when FTR contradicts the score", () => {
  assert.throws(
    () => normalizeMatch(row("Arsenal", "Chelsea", "2", "1", "A"), map, "2021-22", ALIASES),
    /FTR mismatch/,
  )
})

test("normalizeMatch leaves halfTime null when half-time scores are absent", () => {
  const m = normalizeMatch(
    row("Arsenal", "Chelsea", "2", "1", "H", { hthg: "", htag: "", htr: "" }),
    map,
    "2021-22",
    ALIASES,
  )
  assert.equal(m.halfTime, null)
})

// --- normalizeSeason ----------------------------------------------------

test("normalizeSeason sorts deterministically and rejects duplicate IDs", () => {
  const rows = [
    row("Chelsea", "Arsenal", "1", "1", "D", { date: "22/08/2021" }),
    row("Arsenal", "Chelsea", "2", "1", "H", { date: "13/08/2021" }),
  ]
  const matches = normalizeSeason(rows, map, "2021-22", ALIASES)
  assert.deepEqual(
    matches.map((m) => m.date),
    ["2021-08-13", "2021-08-22"],
  )

  // Duplicating the same match (same date + same pair) yields the same ID → throws.
  assert.throws(
    () => normalizeSeason([rows[1], rows[1]], map, "2021-22", ALIASES),
    /duplicate match ID/,
  )
})
