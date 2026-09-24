/**
 * Client-safe lookup for the localized Premier League club crests (Phase XI).
 *
 * The crest bundle is produced once by `scripts/localize-premier-league-crests.ts`
 * and pinned by `data/football/premier-league/2026-27/crest-manifest.json`. This
 * module only imports that manifest — it never reads the filesystem, the network,
 * `process`, or the clock, so it can be imported from both server and client
 * component trees (the fixture cards are rendered inside a client component).
 *
 * Non-Premier-League teams, and any PL team whose crest file is somehow missing,
 * fall back to a deterministic text monogram — there is never a broken image and
 * never a runtime remote request.
 */
import crestManifestJson from "@/data/football/premier-league/2026-27/crest-manifest.json"

export interface TeamCrestEntry {
  teamId: string
  slug: string
  name: string
  /** Local public path, e.g. `/images/teams/premier-league/2026-27/arsenal-fc.png`. */
  localPath: string
  sourceUrl: string
  resolvedSourceUrl: string
  mimeType: string
  sha256: string
  width: number | null
  height: number | null
  localizedAt: string
}

interface CrestManifestFile {
  note: string
  localizedAt: string
  crests: TeamCrestEntry[]
}

const manifest = crestManifestJson as unknown as CrestManifestFile

const crestBySlug = new Map<string, TeamCrestEntry>()
const crestByTeamId = new Map<string, TeamCrestEntry>()
for (const crest of manifest.crests) {
  crestBySlug.set(crest.slug, crest)
  crestByTeamId.set(crest.teamId, crest)
}

/** The trademark note carried in the manifest (used once, not on every card). */
export const teamCrestNote: string = manifest.note

/** All localized crests, in manifest (slug-sorted) order. */
export const teamCrests: readonly TeamCrestEntry[] = manifest.crests

/** The localized crest for a team slug, or null when the team is not a localized PL club. */
export function getTeamCrest(slug: string): TeamCrestEntry | null {
  return crestBySlug.get(slug) ?? null
}

/** The localized crest for a team id, or null when the team is not a localized PL club. */
export function getTeamCrestByTeamId(teamId: string): TeamCrestEntry | null {
  return crestByTeamId.get(teamId) ?? null
}

/**
 * Deterministic text fallback for a team with no localized crest. Club-type
 * tokens ("FC", "AFC", "CFC", "AC", "AS", "SC") and non-letter characters are
 * dropped first, then multi-word names reduce to the initials of their first
 * three words ("Manchester United FC" → "MU") and single-word names reduce to
 * their first three letters ("Chelsea" → "CHE"). The result is a pure function
 * of the name, so it never varies between server and client renders.
 */
const IGNORED_CLUB_TOKENS = new Set(["fc", "afc", "cfc", "cf", "ac", "as", "sc"])

export function teamCrestFallbackText(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Za-zÀ-ÿ]/g, ""))
    .filter((word) => word.length > 0 && !IGNORED_CLUB_TOKENS.has(word.toLowerCase()))
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase()
  return words
    .slice(0, 3)
    .map((word) => word.charAt(0))
    .join("")
    .toUpperCase()
}
