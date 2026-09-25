/**
 * verify-static-export.ts
 *
 * Post-build checks for the fully static `out/` export. Verifies that the
 * build produced a self-contained static site with no server, no API routes,
 * no Supabase/Worker/Cron runtime, and that every dynamic route was statically
 * generated. Exits non-zero if any check fails.
 *
 * Run after `next build`:
 *   npm run verify:static-export
 */

import { existsSync, readFileSync, readdirSync } from "fs"
import { join, relative, resolve } from "path"

const ROOT = resolve(process.cwd())
const OUT = join(ROOT, "out")

interface Check {
  name: string
  fn: () => boolean
}

function outExists(rel: string): boolean {
  return existsSync(join(OUT, rel))
}

/** Recursively list relative paths of all files under `out/`. */
function listOutFiles(): string[] {
  if (!existsSync(OUT)) return []
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(relative(OUT, full).replace(/\\/g, "/"))
    }
  }
  walk(OUT)
  return files
}

/** Count `out/<dir>/<slug>.html` pages (one `.html` file per slug, directly under `<dir>`). */
function countHtmlUnder(dir: string): number {
  const prefix = `${dir.replace(/\\/g, "/")}/`
  return listOutFiles().filter(
    (f) => f.startsWith(prefix) && f.endsWith(".html") && !f.slice(prefix.length).includes("/"),
  ).length
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as T
}

interface Manifest {
  competitions: { slug: string; fixtures: number }[]
}

let manifest: Manifest
let clubCount: number
try {
  manifest = readJson<Manifest>("data/football/manifest.json")
} catch {
  manifest = { competitions: [] }
}
try {
  clubCount = readJson<unknown[]>("data/football/teams.json").length
} catch {
  clubCount = 0
}

const plFixtures = manifest.competitions.find((c) => c.slug === "premier-league")?.fixtures ?? 380
const clFixtures = manifest.competitions.find((c) => c.slug === "champions-league")?.fixtures ?? 144

// Sensitive / runtime strings that must never appear in the static export.
// (Variable/secret names only — never print the values themselves.)
const FORBIDDEN = [
  "supabase",
  "FOOTBALL_DATA_API_KEY",
  "wrangler",
  "opennextjs-cloudflare",
  "open-next",
]

const checks: Check[] = [
  { name: "out/ exists", fn: () => existsSync(OUT) },
  { name: "out/index.html exists", fn: () => outExists("index.html") },
  { name: "out/404.html exists", fn: () => outExists("404.html") },
  { name: "out/sitemap.xml exists", fn: () => outExists("sitemap.xml") },
  { name: "out/robots.txt exists", fn: () => outExists("robots.txt") },
  { name: "out/_headers exists", fn: () => outExists("_headers") },
  { name: "out/_redirects exists", fn: () => outExists("_redirects") },
  { name: "out/favicon.ico exists", fn: () => outExists("favicon.ico") },
  {
    name: "all 3 static OG images present",
    fn: () =>
      outExists("og/ai-football-predictions.png") &&
      outExists("og/premier-league-predictions.png") &&
      outExists("og/world-cup-archive.png"),
  },
  { name: "premier-league hub page", fn: () => outExists("premier-league.html") },
  { name: "champions-league hub page", fn: () => outExists("champions-league.html") },
  { name: "premier-league matches directory", fn: () => outExists("premier-league/matches.html") },
  { name: "champions-league matches directory", fn: () => outExists("champions-league/matches.html") },
  { name: "clubs hub page", fn: () => outExists("clubs.html") },
  { name: "world-cup archive page", fn: () => outExists("world-cup/2026.html") },
  { name: "predictions page", fn: () => outExists("predictions.html") },
  { name: "simulator page", fn: () => outExists("simulator.html") },
  {
    name: `premier-league match detail pages (expect ${plFixtures})`,
    fn: () => countHtmlUnder("premier-league/matches") === plFixtures,
  },
  {
    name: `champions-league match detail pages (expect ${clFixtures})`,
    fn: () => countHtmlUnder("champions-league/matches") === clFixtures,
  },
  {
    name: `club detail pages (expect ${clubCount})`,
    fn: () => countHtmlUnder("clubs") === clubCount,
  },
  {
    name: "world-cup team pages generated (>= 40)",
    fn: () => countHtmlUnder("team") >= 40,
  },
  {
    name: "world-cup match pages generated (>= 70)",
    fn: () => countHtmlUnder("match") >= 70,
  },
  { name: "no API routes (out/api absent)", fn: () => !existsSync(join(OUT, "api")) },
  {
    name: "no server RSC payloads (.rsc absent)",
    fn: () => !listOutFiles().some((f) => f.endsWith(".rsc")),
  },
  {
    name: "no runtime/secret strings in static files",
    fn: () => {
      const textFiles = listOutFiles().filter((f) =>
        /\.(html|js|css|txt|xml|json|webmanifest)$/i.test(f),
      )
      for (const f of textFiles) {
        const content = readFileSync(join(OUT, f), "utf8")
        for (const needle of FORBIDDEN) {
          if (content.toLowerCase().includes(needle.toLowerCase())) {
            console.error(`  ✗ "${needle}" found in ${f}`)
            return false
          }
        }
      }
      return true
    },
  },
]

function main() {
  if (!existsSync(OUT)) {
    console.error("✗ out/ does not exist — run `next build` first.")
    process.exit(1)
  }

  let failures = 0
  console.log(`Verifying static export (${checks.length} checks)...\n`)
  for (const [i, check] of checks.entries()) {
    const ok = check.fn()
    console.log(`  ${ok ? "✓" : "✗"} ${String(i + 1).padStart(2)}. ${check.name}`)
    if (!ok) failures++
  }

  console.log(
    `\n${failures === 0 ? "✓" : "✗"} ${checks.length - failures}/${checks.length} checks passed`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main()
