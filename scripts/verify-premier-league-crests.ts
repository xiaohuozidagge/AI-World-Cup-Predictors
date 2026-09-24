/**
 * Offline verification of the localized Premier League crest bundle.
 *
 * This script reads ONLY local files — the static football snapshot, the crest
 * manifest and the downloaded crest files — and never connects to the network.
 * It exists so the crest bundle can be re-validated in CI or on any checkout
 * without credentials, and so a tampered, missing or unsafe crest fails loudly
 * (exit 1) instead of being silently replaced by a fallback monogram.
 *
 * It checks the same safety rules the one-time localizer enforced, plus the
 * build-time invariants the site depends on:
 *   - the manifest covers exactly the 20 Premier League teams (by teamId and by
 *     slug, both directions) and no other team;
 *   - every localPath is a local `/images/...` path (never a remote URL) and the
 *     file exists on disk;
 *   - every file's SHA-256 matches the manifest pin;
 *   - the declared MIME type matches the file extension and the real magic bytes
 *     (no HTML error pages, no mislabelled bitmaps);
 *   - SVG payloads (if any) contain no <script>, event handlers, javascript: URIs
 *     or remote references;
 *   - bitmap dimensions are recorded and positive.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const DATA_DIR = join(process.cwd(), "data", "football")
const CREST_DIR = join(process.cwd(), "public", "images", "teams", "premier-league", "2026-27")
const MANIFEST_PATH = join(DATA_DIR, "premier-league", "2026-27", "crest-manifest.json")

const PREMIER_LEAGUE_SLUG = "premier-league"
const EXPECTED_TEAMS = 20

const ALLOWED_MIME = new Set(["image/png", "image/svg+xml", "image/webp"])
const MIME_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
}
const TRADEMARK_NOTE_FRAGMENT = "All trademarks and visual identities belong to their respective owners"

interface RawTeam {
  id: string
  name: string
  slug: string
}
interface RawCompetition {
  id: string
  slug: string
}
interface RawFixture {
  competition_id: string
  home_team_id: string
  away_team_id: string
}
interface CrestEntry {
  teamId: string
  slug: string
  name: string
  localPath: string
  sourceUrl: string
  resolvedSourceUrl: string
  mimeType: string
  sha256: string
  width: number | null
  height: number | null
  localizedAt: string
}
interface ManifestFile {
  note: string
  localizedAt: string
  crests: CrestEntry[]
}

// --- error collector ---------------------------------------------------------

const errors: string[] = []
function fail(message: string): void {
  errors.push(message)
}

// --- helpers -----------------------------------------------------------------

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}

function isPng(buf: Buffer): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  )
}

function isWebp(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP"
  )
}

function svgViolations(svg: string): string | null {
  const lower = svg.toLowerCase()
  if (lower.includes("<script")) return "contains a <script> element"
  if (/\son\w+\s*=/.test(lower)) return "contains an event-handler attribute"
  if (/javascript\s*:/i.test(svg)) return "contains a javascript: URI"
  if (/https?:\/\//i.test(svg)) return "references a remote URL"
  if (lower.includes("<foreignobject")) return "contains a foreignObject element"
  const stripped = svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .trim()
  if (!/^<svg[\s>]/i.test(stripped)) return "does not start with an <svg> element"
  if (!/<\/svg>\s*$/i.test(stripped)) return "does not close the <svg> element"
  return null
}

function isValidIso(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value))
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    fail(`missing file ${path}`)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"))
  } catch (err) {
    fail(`failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`${path} root is not an object`)
    return null
  }
  return parsed as Record<string, unknown>
}

function readJsonArray(file: string): unknown[] {
  const path = join(DATA_DIR, file)
  if (!existsSync(path)) {
    fail(`missing file ${file}`)
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"))
  } catch (err) {
    fail(`failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  if (!Array.isArray(parsed)) {
    fail(`${file} root is not an array`)
    return []
  }
  return parsed
}

// --- main ---------------------------------------------------------------------

function main(): void {
  const competitions = readJsonArray("competitions.json") as unknown as RawCompetition[]
  const teams = readJsonArray("teams.json") as unknown as RawTeam[]
  const fixtures = readJsonArray("fixtures.json") as unknown as RawFixture[]

  const manifestRaw = readJsonObject(MANIFEST_PATH)
  const manifest = manifestRaw as unknown as ManifestFile | null

  // --- resolve the 20 Premier League teams from the snapshot -----------------

  const pl = competitions.find((c) => c.slug === PREMIER_LEAGUE_SLUG)
  if (!pl) {
    fail(`competition with slug ${PREMIER_LEAGUE_SLUG} not found`)
    report(0)
    return
  }

  const plFixtures = fixtures.filter((f) => f.competition_id === pl.id)
  const teamById = new Map(teams.map((t) => [t.id, t]))
  const plTeamIdSet = new Set<string>()
  for (const f of plFixtures) {
    plTeamIdSet.add(f.home_team_id)
    plTeamIdSet.add(f.away_team_id)
  }
  const plTeams = [...plTeamIdSet].map((id) => teamById.get(id)).filter((t): t is RawTeam => Boolean(t))

  if (plTeams.length !== EXPECTED_TEAMS) {
    fail(`Premier League has ${plTeams.length} teams (expected ${EXPECTED_TEAMS})`)
  }
  const plTeamIds = new Set(plTeams.map((t) => t.id))
  const plTeamSlugs = new Set(plTeams.map((t) => t.slug))
  if (plTeamIds.size !== plTeams.length) fail("duplicate team id among PL teams")
  if (plTeamSlugs.size !== plTeams.length) fail("duplicate team slug among PL teams")

  // --- manifest shape ----------------------------------------------------------

  if (manifest === null) {
    report(0)
    return
  }
  if (typeof manifest.note !== "string" || !manifest.note.includes(TRADEMARK_NOTE_FRAGMENT)) {
    fail("manifest.note is missing the trademark disclaimer")
  }
  if (!isValidIso(manifest.localizedAt)) fail("manifest.localizedAt is not a valid ISO timestamp")
  if (!Array.isArray(manifest.crests)) {
    fail("manifest.crests is not an array")
    report(plTeams.length)
    return
  }

  const crests = manifest.crests
  if (crests.length !== EXPECTED_TEAMS) {
    fail(`manifest has ${crests.length} crests (expected ${EXPECTED_TEAMS})`)
  }

  // --- uniqueness ---------------------------------------------------------------

  const crestTeamIds = new Set<string>()
  const crestSlugs = new Set<string>()
  const crestPaths = new Set<string>()
  for (const c of crests) {
    if (!c.teamId) fail("crest entry with empty teamId")
    else if (crestTeamIds.has(c.teamId)) fail(`duplicate crest teamId ${c.teamId}`)
    else crestTeamIds.add(c.teamId)

    if (!c.slug) fail("crest entry with empty slug")
    else if (crestSlugs.has(c.slug)) fail(`duplicate crest slug ${c.slug}`)
    else crestSlugs.add(c.slug)

    if (!c.localPath) fail(`crest ${c.slug} with empty localPath`)
    else if (crestPaths.has(c.localPath)) fail(`duplicate crest localPath ${c.localPath}`)
    else crestPaths.add(c.localPath)
  }

  // --- 1:1 against the snapshot (both directions) --------------------------------

  for (const c of crests) {
    if (!plTeamIds.has(c.teamId)) fail(`crest ${c.slug} teamId ${c.teamId} is not a Premier League team`)
    if (!plTeamSlugs.has(c.slug)) fail(`crest slug ${c.slug} is not a Premier League team slug`)
  }
  for (const t of plTeams) {
    if (!crestTeamIds.has(t.id)) fail(`PL team ${t.name} (${t.slug}) has no crest entry`)
    if (!crestSlugs.has(t.slug)) fail(`PL team ${t.name} has no crest entry for slug ${t.slug}`)
  }

  // --- per-file validation --------------------------------------------------------

  for (const c of crests) {
    if (!c.name) fail(`crest ${c.slug} has no name`)
    if (!isValidIso(c.localizedAt)) fail(`crest ${c.slug} has an invalid localizedAt`)

    if (!ALLOWED_MIME.has(c.mimeType)) {
      fail(`crest ${c.slug} has unsupported mimeType ${c.mimeType}`)
      continue
    }

    // localPath must be local and stable, never a remote URL.
    if (!c.localPath.startsWith("/images/teams/premier-league/2026-27/")) {
      fail(`crest ${c.slug} localPath is not under the local team crest directory: ${c.localPath}`)
    }
    if (/^https?:\/\//i.test(c.localPath)) {
      fail(`crest ${c.slug} localPath is a remote URL: ${c.localPath}`)
    }
    const expectedExt = MIME_EXTENSION[c.mimeType]
    if (expectedExt && !c.localPath.endsWith(expectedExt)) {
      fail(`crest ${c.slug} localPath extension does not match ${c.mimeType}`)
    }

    const absPath = join(process.cwd(), "public", c.localPath.replace(/^\//, ""))
    if (!existsSync(absPath)) {
      fail(`crest ${c.slug} file missing on disk: ${absPath}`)
      continue
    }
    const buf = readFileSync(absPath)
    if (buf.length === 0) fail(`crest ${c.slug} file is empty`)

    const actualHash = sha256(buf)
    if (actualHash !== c.sha256) {
      fail(`crest ${c.slug} SHA-256 mismatch: ${actualHash.slice(0, 12)}… != ${c.sha256.slice(0, 12)}…`)
    }

    if (c.mimeType === "image/png" && !isPng(buf)) {
      fail(`crest ${c.slug} declares image/png but is not a real PNG`)
    } else if (c.mimeType === "image/webp" && !isWebp(buf)) {
      fail(`crest ${c.slug} declares image/webp but is not a real WebP`)
    } else if (c.mimeType === "image/svg+xml") {
      const violation = svgViolations(buf.toString("utf8"))
      if (violation) fail(`crest ${c.slug} SVG rejected: ${violation}`)
    }

    // Bitmap dimensions must be recorded and positive; SVG keeps null (vector).
    if (c.mimeType !== "image/svg+xml") {
      if (!Number.isInteger(c.width) || (c.width ?? 0) <= 0) {
        fail(`crest ${c.slug} has no positive recorded width`)
      }
      if (!Number.isInteger(c.height) || (c.height ?? 0) <= 0) {
        fail(`crest ${c.slug} has no positive recorded height`)
      }
    }
  }

  // --- source URLs are HTTPS metadata only (never fetched by the build) ----------

  for (const c of crests) {
    if (!c.sourceUrl || !c.sourceUrl.startsWith("https://")) {
      fail(`crest ${c.slug} sourceUrl is not HTTPS: ${String(c.sourceUrl)}`)
    }
    if (!c.resolvedSourceUrl || !c.resolvedSourceUrl.startsWith("https://")) {
      fail(`crest ${c.slug} resolvedSourceUrl is not HTTPS: ${String(c.resolvedSourceUrl)}`)
    }
  }

  report(plTeams.length)
}

function report(plTeamCount: number): void {
  if (errors.length > 0) {
    console.error(`\nCrest verification FAILED with ${errors.length} error(s):`)
    for (const e of errors) console.error(`- ${e}`)
    process.exit(1)
  }
  console.log(
    `Crest verification PASSED: ${plTeamCount} Premier League teams, ` +
      `${existsSync(MANIFEST_PATH) ? (JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as ManifestFile).crests.length : 0} localized crests`,
  )
}

main()
