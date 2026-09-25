#!/usr/bin/env tsx
import { readFileSync, existsSync } from "fs"
import { join } from "path"

const DATA_DIR = join(import.meta.dirname || __dirname, "..", "data", "synced")
const ROOT = join(import.meta.dirname || __dirname, "..")
const errors: string[] = []

// 1. Server secrets are not baked into the Next.js build.
// Next auto-loads .env / .env.local / .env.production at build time and
// inlines them into the bundle — so none of them may hold a real secret.
// Secrets live only in .env.sync (gitignored).
const SECRET_NAMES = ["FOOTBALL_DATA_API_KEY"]
const PLACEHOLDERS = ["", "your_api_key_here", "your-secret-key-here", "replace-me"]

function hasRealSecret(content: string, name: string): boolean {
  const prefix = `${name}=`
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim().startsWith(prefix)) continue
    const value = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")
    if (value && !PLACEHOLDERS.includes(value.toLowerCase())) return true
  }
  return false
}

const nextAutoLoaded = [".env", ".env.local", ".env.production"]
for (const f of nextAutoLoaded) {
  const p = join(ROOT, f)
  if (!existsSync(p)) continue
  const content = readFileSync(p, "utf-8")
  for (const name of SECRET_NAMES) {
    if (hasRealSecret(content, name)) {
      errors.push(`${f} still contains a real ${name} — move it to .env.sync (it would be baked into .next)`)
    }
  }
}

const syncEnvPath = join(ROOT, ".env.sync")
if (existsSync(syncEnvPath)) {
  const content = readFileSync(syncEnvPath, "utf-8")
  const hasKey = SECRET_NAMES.some((name) => hasRealSecret(content, name))
  const gitignore = existsSync(join(ROOT, ".gitignore"))
    ? readFileSync(join(ROOT, ".gitignore"), "utf-8")
    : ""
  if (hasKey && !gitignore.split(/\r?\n/).some((l) => l.trim() === ".env.sync")) {
    errors.push(".env.sync holds a real key but is not listed in .gitignore")
  }
}

// 2. Synced JSON files are valid JSON
const syncedFiles = ["matches.json", "standings.json", "teams.json", "last-updated.json"]
for (const f of syncedFiles) {
  const p = join(DATA_DIR, f)
  if (existsSync(p)) {
    try {
      JSON.parse(readFileSync(p, "utf-8"))
      console.log(`  ✓ ${f} is valid JSON`)
    } catch {
      errors.push(`${f} is not valid JSON`)
    }
  } else {
    console.log(`  - ${f} does not exist (OK before first sync)`)
  }
}

// 3. Check sitemap domain
const sitemap = readFileSync(join(ROOT, "app", "sitemap.ts"), "utf-8")
if (!sitemap.includes("aipredictor.world")) errors.push("Sitemap does not use aipredictor.world")
else console.log("  ✓ Sitemap uses aipredictor.world")

// 4. Check robots domain
const robots = readFileSync(join(ROOT, "app", "robots.ts"), "utf-8")
if (!robots.includes("aipredictor.world")) errors.push("Robots.txt does not use aipredictor.world")
else console.log("  ✓ Robots.txt uses aipredictor.world")

// 5. No old domain
const srcFiles = ["app/layout.tsx", "app/sitemap.ts", "app/robots.ts", "lib/constants.ts", "lib/jsonld.tsx"]
for (const f of srcFiles) {
  const content = readFileSync(join(ROOT, f), "utf-8")
  if (content.includes("aiworldcuppredictions.com")) errors.push(`${f} still references old domain`)
}
console.log("  ✓ No old domain references in source files")

// 6. Synced data integrity
if (existsSync(join(DATA_DIR, "matches.json"))) {
  const matches = JSON.parse(readFileSync(join(DATA_DIR, "matches.json"), "utf-8"))
  const slugs = matches.map((m: { slug: string }) => m.slug)
  const dupSlugs = slugs.filter((s: string, i: number) => slugs.indexOf(s) !== i)
  if (dupSlugs.length) errors.push(`Duplicate match slugs: ${[...new Set(dupSlugs)].join(", ")}`)

  const finished = matches.filter((m: { status: string }) => m.status === "finished")
  const finishedNoScore = finished.filter((m: { actualScore?: unknown }) => !m.actualScore)
  if (finishedNoScore.length) errors.push(`${finishedNoScore.length} finished matches have no actualScore`)

  const scheduled = matches.filter((m: { status: string }) => m.status === "scheduled")
  const scheduledWithScore = scheduled.filter((m: { actualScore?: unknown }) => m.actualScore)
  if (scheduledWithScore.length) errors.push(`${scheduledWithScore.length} scheduled matches have actualScore`)

  console.log(`  ✓ ${matches.length} synced matches, ${finished.length} finished, ${scheduled.length} scheduled`)
}

console.log(errors.length ? `\n❌ ${errors.length} errors:` : `\n✅ Validation passed`)
errors.forEach(e => console.log(`  - ${e}`))
process.exit(errors.length ? 1 : 0)
