import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  getTeamCrest,
  getTeamCrestByTeamId,
  teamCrestFallbackText,
  teamCrestNote,
  teamCrests,
} from "./team-crests"

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex")

test("exactly 20 Premier League crests are localized", () => {
  assert.equal(teamCrests.length, 20)
})

test("crest entries have unique teamId, slug and localPath", () => {
  assert.equal(new Set(teamCrests.map((c) => c.teamId)).size, 20)
  assert.equal(new Set(teamCrests.map((c) => c.slug)).size, 20)
  assert.equal(new Set(teamCrests.map((c) => c.localPath)).size, 20)
})

test("every crest resolves by slug and by team id, and its file matches the SHA-256 pin", () => {
  for (const c of teamCrests) {
    assert.equal(getTeamCrest(c.slug), c, `${c.slug} should resolve by slug`)
    assert.equal(getTeamCrestByTeamId(c.teamId), c, `${c.slug} should resolve by team id`)
    const abs = join(process.cwd(), "public", c.localPath.replace(/^\//, ""))
    assert.ok(existsSync(abs), `${c.slug} crest file is missing on disk`)
    assert.equal(sha256(readFileSync(abs)), c.sha256, `${c.slug} SHA-256 does not match the manifest`)
    assert.ok(c.localPath.endsWith(".png"), `${c.slug} is not a .png asset`)
    assert.ok(c.width != null && c.width > 0, `${c.slug} has no recorded width`)
    assert.ok(c.height != null && c.height > 0, `${c.slug} has no recorded height`)
  }
})

test("unknown slugs and team ids resolve to null (no broken-image path)", () => {
  assert.equal(getTeamCrest("not-a-real-team"), null)
  assert.equal(getTeamCrestByTeamId("00000000-0000-0000-0000-000000000000"), null)
})

test("the manifest carries the trademark disclaimer", () => {
  assert.match(teamCrestNote, /trademarks/i)
  assert.match(teamCrestNote, /respective owners/i)
})

test("fallback text is deterministic and derives from the club name", () => {
  assert.equal(teamCrestFallbackText("Chelsea FC"), "CHE")
  assert.equal(teamCrestFallbackText("Manchester United FC"), "MU")
  assert.equal(teamCrestFallbackText("AFC Bournemouth"), "BOU")
  assert.equal(teamCrestFallbackText("Brighton & Hove Albion FC"), "BHA")
  assert.equal(teamCrestFallbackText(""), "?")
  assert.equal(teamCrestFallbackText("   "), "?")
})
