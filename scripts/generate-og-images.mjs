// Offline static OG-image generator (1200×630). Replaces the removed
// `next/og` ImageResponse routes. Run: `node scripts/generate-og-images.mjs`.
import sharp from "sharp"
import { mkdirSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, "public", "og")

const GREEN = "#16a34a"
const BLUE = "#2563eb"
const DARK = "#0f172a"
const LIGHT = "#f8fafc"

function svg({ eyebrow, title, accent }) {
  return `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${DARK}" />
      <stop offset="100%" stop-color="#1e293b" />
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)" />
  <circle cx="1080" cy="80" r="220" fill="${accent}" opacity="0.14" />
  <circle cx="120" cy="560" r="260" fill="${BLUE}" opacity="0.12" />
  <rect x="72" y="72" width="1056" height="486" rx="28" fill="none" stroke="${accent}" stroke-opacity="0.35" stroke-width="2" />
  <text x="96" y="180" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="700" fill="${accent}" letter-spacing="6">${eyebrow.toUpperCase()}</text>
  <text x="96" y="330" font-family="Arial, Helvetica, sans-serif" font-size="88" font-weight="800" fill="${LIGHT}">${title}</text>
  <text x="96" y="430" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="400" fill="#94a3b8">AI Football Predictions &amp; Match Analysis</text>
  <text x="96" y="500" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="600" fill="${accent}">aipredictor.world</text>
</svg>`
}

const images = [
  {
    file: "ai-football-predictions.png",
    eyebrow: "AI Predictor",
    title: "AI Football Predictions",
    accent: GREEN,
  },
  {
    file: "premier-league-predictions.png",
    eyebrow: "Premier League 2026/27",
    title: "Premier League Predictions",
    accent: GREEN,
  },
  {
    file: "world-cup-archive.png",
    eyebrow: "Archive",
    title: "World Cup 2026",
    accent: BLUE,
  },
]

mkdirSync(OUT, { recursive: true })

for (const { file, eyebrow, title, accent } of images) {
  await sharp(Buffer.from(svg({ eyebrow, title, accent })), { density: 72 })
    .resize(1200, 630)
    .png()
    .toFile(join(OUT, file))
  console.log("wrote", join("public", "og", file))
}
