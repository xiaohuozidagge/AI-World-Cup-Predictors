import { test } from "node:test"
import assert from "node:assert/strict"

import {
  buildE0HeaderMap,
  isBlankRow,
  parseCsv,
  parseDmyDate,
  parseLocalTime,
} from "./history-csv"

// --- parseCsv: RFC 4180 -----------------------------------------------

test("parseCsv splits a simple comma-separated grid", () => {
  assert.deepEqual(parseCsv("a,b,c\n1,2,3"), [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ])
})

test("parseCsv keeps commas inside quoted fields", () => {
  assert.deepEqual(parseCsv('"a,b",c\n1,"x,y"'), [
    ["a,b", "c"],
    ["1", "x,y"],
  ])
})

test("parseCsv unescapes doubled quotes inside quoted fields", () => {
  assert.deepEqual(parseCsv('"say ""hi""",x'), [["say \"hi\"", "x"]])
})

test("parseCsv handles CRLF line endings", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n3,4"), [
    ["a", "b"],
    ["1", "2"],
    ["3", "4"],
  ])
})

test("parseCsv handles a newline inside a quoted field", () => {
  assert.deepEqual(parseCsv('"line1\nline2",b\nc,d'), [
    ["line1\nline2", "b"],
    ["c", "d"],
  ])
})

test("parseCsv handles a final row without a trailing newline", () => {
  assert.deepEqual(parseCsv("a,b\nc,d"), [
    ["a", "b"],
    ["c", "d"],
  ])
})

test("parseCsv strips a leading UTF-8 BOM", () => {
  assert.deepEqual(parseCsv("﻿Date,HomeTeam"), [["Date", "HomeTeam"]])
})

test("parseCsv preserves trailing empty fields", () => {
  assert.deepEqual(parseCsv("a,b,\n"), [["a", "b", ""]])
})

test("isBlankRow detects empty and whitespace-only rows", () => {
  assert.equal(isBlankRow([]), true)
  assert.equal(isBlankRow(["", "", ""]), true)
  assert.equal(isBlankRow([" ", "\t"]), true)
  assert.equal(isBlankRow(["a", ""]), false)
})

// --- buildE0HeaderMap --------------------------------------------------

test("buildE0HeaderMap maps required and optional columns", () => {
  const map = buildE0HeaderMap(["Div", "Date", "Time", "HomeTeam", "AwayTeam", "FTHG", "FTAG", "FTR", "HTHG", "HTAG", "HTR"])
  assert.equal(map.date, 1)
  assert.equal(map.homeTeam, 3)
  assert.equal(map.awayTeam, 4)
  assert.equal(map.time, 2)
  assert.equal(map.hthg, 8)
  assert.equal(map.htr, 10)
})

test("buildE0HeaderMap tolerates missing optional columns", () => {
  const map = buildE0HeaderMap(["Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG", "FTR"])
  assert.equal(map.time, null)
  assert.equal(map.hthg, null)
  assert.equal(map.div, null)
})

test("buildE0HeaderMap throws on a missing required column", () => {
  assert.throws(() => buildE0HeaderMap(["Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG"]), /missing required column/)
})

// --- date / time parsing ----------------------------------------------

test("parseDmyDate converts DD/MM/YYYY to YYYY-MM-DD", () => {
  assert.equal(parseDmyDate("13/08/2021"), "2021-08-13")
  assert.equal(parseDmyDate("5/1/2022"), "2022-01-05")
})

test("parseDmyDate rejects malformed and impossible dates", () => {
  assert.throws(() => parseDmyDate("2021-08-13"))
  assert.throws(() => parseDmyDate("13/08/21"))
  assert.throws(() => parseDmyDate("30/02/2021")) // Feb 30
  assert.throws(() => parseDmyDate("00/01/2021"))
  assert.throws(() => parseDmyDate("13/13/2021")) // month 13
})

test("parseLocalTime returns the time for valid HH:MM and null for blank", () => {
  assert.equal(parseLocalTime("20:00"), "20:00")
  assert.equal(parseLocalTime(""), null)
  assert.equal(parseLocalTime("   "), null)
  assert.throws(() => parseLocalTime("8pm"))
})
