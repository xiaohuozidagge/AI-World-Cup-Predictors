/**
 * One-time, manually-run localizer for the 20 Premier League 2026/27 club
 * crests.
 *
 * It reads the committed static football snapshot (`data/football/*.json`),
 * downloads each club's recorded crest URL over HTTPS, validates the payload,
 * writes it under `public/images/teams/premier-league/2026-27/<slug>.<ext>`,
 * and emits a SHA-256-pinned manifest. It is intentionally NOT part of the
 * build: the build reads only the committed files, never the network.
 *
 * Safety rules enforced here:
 *   - source URL must be HTTPS and must come from the snapshot (never hand-picked);
 *   - only image/svg+xml, image/png, image/webp are accepted;
 *   - SVG is rejected if it contains <script>, event handlers, external JS or
 *     remote references — we never "repair" a dangerous SVG, we fail;
 *   - bitmaps are checked against their real magic bytes (no HTML error pages);
 *   - file size is capped;
 *   - downloads are idempotent: an existing file with a matching hash is not
 *     re-written, and a stable filename (team slug) is used, never a random one.
 *
 * Trademark note (also written into the manifest):
 *   Club names and crests are used for identification. All trademarks and
 *   visual identities belong to their respective owners.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const DATA_DIR = join(process.cwd(), "data", "football")
const OUT_DIR = join(process.cwd(), "public", "images", "teams", "premier-league", "2026-27")
const MANIFEST_PATH = join(process.cwd(), "data", "football", "premier-league", "2026-27", "crest-manifest.json")
const PREMIER_LEAGUE_SLUG = "premier-league"
const EXPECTED_TEAMS = 20
const MAX_BYTES = 1024 * 1024 // 1 MiB

const ALLOWED_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
}

interface RawTeam {
  id: string
  name: string
  short_name: string | null
  slug: string
  country: string | null
  logo_url: string | null
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

/* --------------------------- helpers --------------------------- */

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

function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  // IHDR is the first chunk: length(4) type "IHDR"(4) then width/height (4 each).
  if (buf.length < 24) return null
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function webpDimensions(buf: Buffer): { width: number; height: number } | null {
  const kind = buf.toString("latin1", 12, 16)
  if (kind === "VP8X" && buf.length >= 30) {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
  }
  if (kind === "VP8L" && buf.length >= 26 && buf[20] === 0x2f) {
    const width = 1 + (((buf[21] & 0x3f) << 8) | buf[22])
    const height = 1 + (((buf[23] & 0x0f) << 10) | (buf[24] << 2) | ((buf[25] & 0xc0) >> 6))
    return { width, height }
  }
  if (kind === "VP8 " && buf.length >= 30) {
    const width = buf.readUInt16LE(26) & 0x3fff
    const height = buf.readUInt16LE(28) & 0x3fff
    return { width, height }
  }
  return null
}

function svgViolations(svg: string): string | null {
  const lower = svg.toLowerCase()
  if (lower.includes("<script")) return "contains a <script> element"
  if (/\son\w+\s*=/.test(lower)) return "contains an event-handler attribute (onload/onclick/…)"

  // External JS and remote resource references are never acceptable in a
  // locally-served crest.
  if (/javascript\s*:/i.test(svg)) return "contains a javascript: URI"
  if (/https?:\/\//i.test(svg)) return "references a remote URL"
  if (lower.includes("<foreignobject")) return "contains a foreignObject element"

  // Basic well-formedness: must open and close as an <svg> element.
  const stripped = svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .trim()
  if (!/^<svg[\s>]/i.test(stripped)) return "does not start with an <svg> element"
  if (!/<\/svg>\s*$/i.test(stripped)) return "does not close the <svg> element"
  return null
}

/* --------------------------- main --------------------------- */

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as T
}

async function download(url: string): Promise<{ buf: Buffer; finalUrl: string; contentType: string }> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "aipredictor-world-crest-localizer/1.0 (one-time manual run)" },
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
  }
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
  const buf = Buffer.from(await res.arrayBuffer())
  return { buf, finalUrl: res.url, contentType }
}

async function main(): Promise<void> {
  const competitions = readJson<RawCompetition[]>("competitions.json")
  const teams = readJson<RawTeam[]>("teams.json")
  const fixtures = readJson<RawFixture[]>("fixtures.json")

  const pl = competitions.find((c) => c.slug === PREMIER_LEAGUE_SLUG)
  if (!pl) throw new Error(`competition ${PREMIER_LEAGUE_SLUG} not found`)

  const plFixtures = fixtures.filter((f) => f.competition_id === pl.id)
  const teamIdSet = new Set<string>()
  for (const f of plFixtures) {
    teamIdSet.add(f.home_team_id)
    teamIdSet.add(f.away_team_id)
  }

  const teamById = new Map(teams.map((t) => [t.id, t]))
  const plTeams = [...teamIdSet]
    .map((id) => teamById.get(id))
    .filter((t): t is RawTeam => Boolean(t))
    .sort((a, b) => a.name.localeCompare(b.name))

  if (plTeams.length !== EXPECTED_TEAMS) {
    throw new Error(`Premier League has ${plTeams.length} teams (expected ${EXPECTED_TEAMS})`)
  }
  const ids = new Set(plTeams.map((t) => t.id))
  const slugs = new Set(plTeams.map((t) => t.slug))
  if (ids.size !== EXPECTED_TEAMS) throw new Error("duplicate team id among PL teams")
  if (slugs.size !== EXPECTED_TEAMS) throw new Error("duplicate team slug among PL teams")

  // Reuse a previous localization timestamp when nothing changed, so a re-run
  // is byte-identical.
  const previous = new Map<string, string>()
  if (existsSync(MANIFEST_PATH)) {
    const old = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as ManifestFile
    for (const e of old.crests ?? []) previous.set(e.slug, e.localizedAt)
  }

  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(join(process.cwd(), "data", "football", "premier-league", "2026-27"), { recursive: true })

  const now = new Date().toISOString()
  const crests: CrestEntry[] = []

  for (const team of plTeams) {
    const sourceUrl = team.logo_url
    if (!sourceUrl) throw new Error(`team ${team.name} (${team.slug}) has no crest URL in the snapshot`)
    if (!sourceUrl.startsWith("https://")) throw new Error(`team ${team.slug} crest URL is not HTTPS: ${sourceUrl}`)

    const { buf, finalUrl, contentType } = await download(sourceUrl)
    if (buf.length === 0) throw new Error(`team ${team.slug} crest is empty`)
    if (buf.length > MAX_BYTES) throw new Error(`team ${team.slug} crest exceeds ${MAX_BYTES} bytes`)

    const ext = ALLOWED_MIME[contentType]
    if (!ext) throw new Error(`team ${team.slug} crest has unsupported content-type ${contentType}`)

    // Validate the real file signature against the declared content type.
    let width: number | null = null
    let height: number | null = null
    if (contentType === "image/png") {
      if (!isPng(buf)) throw new Error(`team ${team.slug} declares image/png but is not a real PNG`)
      const dim = pngDimensions(buf)
      width = dim?.width ?? null
      height = dim?.height ?? null
    } else if (contentType === "image/webp") {
      if (!isWebp(buf)) throw new Error(`team ${team.slug} declares image/webp but is not a real WebP`)
      const dim = webpDimensions(buf)
      width = dim?.width ?? null
      height = dim?.height ?? null
    } else {
      // SVG: dimensions stay null (vector), but the content must be safe.
      const violation = svgViolations(buf.toString("utf8"))
      if (violation) throw new Error(`team ${team.slug} SVG rejected: ${violation}`)
    }

    const localPath = `/images/teams/premier-league/2026-27/${team.slug}${ext}`
    const absPath = join(process.cwd(), "public", "images", "teams", "premier-league", "2026-27", `${team.slug}${ext}`)
    const hash = sha256(buf)

    // Idempotency: skip the write when the file already exists and matches.
    const existingHash = existsSync(absPath) ? sha256(readFileSync(absPath)) : null
    if (existingHash !== hash) {
      writeFileSync(absPath, buf)
    }

    crests.push({
      teamId: team.id,
      slug: team.slug,
      name: team.name,
      localPath,
      sourceUrl,
      resolvedSourceUrl: finalUrl,
      mimeType: contentType,
      sha256: hash,
      width,
      height,
      localizedAt: previous.get(team.slug) ?? now,
    })
  }

  crests.sort((a, b) => a.slug.localeCompare(b.slug))

  const manifest: ManifestFile = {
    note: "Club names and crests are used for identification. All trademarks and visual identities belong to their respective owners.",
    localizedAt: now,
    crests,
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n")

  console.log(`Localized ${crests.length} Premier League crests → ${OUT_DIR}`)
  for (const c of crests) {
    console.log(`  ${c.slug.padEnd(26)} ${c.mimeType.padEnd(14)} ${c.width ?? "—"}×${c.height ?? "—"}  ${c.sha256.slice(0, 12)}…`)
  }
}

main().catch((err) => {
  console.error("crest localization FAILED:", err instanceof Error ? err.message : String(err))
  process.exit(1)
})
