import type { MetadataRoute } from "next"
import { matches } from "@/data/matches"
import { teams } from "@/data/teams"
import { SITE_URL } from "@/lib/constants"
import { getStaticClubsForSitemap } from "@/lib/football/static-club-queries"
import { getStaticMatchesForSitemap } from "@/lib/football/static-queries"
import { matchSitemapPriority } from "@/lib/football/match-logic"
import { buildMatchUrl } from "@/lib/football/match-url"

export const dynamic = "force-static"

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = SITE_URL

  const staticRoutes = [
    { url: baseUrl, lastModified: "2026-06-11", changeFrequency: "daily" as const, priority: 1 },
    { url: `${baseUrl}/predictions`, lastModified: "2026-06-11", changeFrequency: "daily" as const, priority: 0.9 },
    { url: `${baseUrl}/champions-league`, lastModified: "2026-09-19", changeFrequency: "daily" as const, priority: 0.8 },
    { url: `${baseUrl}/premier-league`, lastModified: "2026-09-19", changeFrequency: "daily" as const, priority: 0.8 },
    { url: `${baseUrl}/teams`, lastModified: "2026-06-11", changeFrequency: "weekly" as const, priority: 0.8 },
    { url: `${baseUrl}/schedule`, lastModified: "2026-06-11", changeFrequency: "weekly" as const, priority: 0.8 },
    { url: `${baseUrl}/winner-predictions`, lastModified: "2026-06-11", changeFrequency: "weekly" as const, priority: 0.9 },
    { url: `${baseUrl}/methodology`, lastModified: "2026-06-11", changeFrequency: "monthly" as const, priority: 0.6 },
    { url: `${baseUrl}/about`, lastModified: "2026-06-11", changeFrequency: "monthly" as const, priority: 0.6 },
    { url: `${baseUrl}/how-we-predict`, lastModified: "2026-06-11", changeFrequency: "monthly" as const, priority: 0.6 },
    { url: `${baseUrl}/data-sources`, lastModified: "2026-06-11", changeFrequency: "monthly" as const, priority: 0.5 },
    { url: `${baseUrl}/contact`, lastModified: "2026-06-11", changeFrequency: "monthly" as const, priority: 0.5 },
    { url: `${baseUrl}/ai-track-record`, lastModified: "2026-06-11", changeFrequency: "daily" as const, priority: 0.8 },
    { url: `${baseUrl}/2026-world-cup-group-predictions`, lastModified: "2026-06-11", changeFrequency: "weekly" as const, priority: 0.85 },
    { url: `${baseUrl}/2026-world-cup-group-a-predictions`, lastModified: "2026-06-11", changeFrequency: "weekly" as const, priority: 0.8 },
    { url: `${baseUrl}/2026-world-cup-group-b-predictions`, lastModified: "2026-06-11", changeFrequency: "weekly" as const, priority: 0.8 },
    { url: `${baseUrl}/2026-world-cup-group-c-predictions`, lastModified: "2026-06-11", changeFrequency: "weekly" as const, priority: 0.8 },
    { url: `${baseUrl}/2026-world-cup-group-d-predictions`, lastModified: "2026-06-11", changeFrequency: "weekly" as const, priority: 0.8 },
  ]

  // Only group-stage matches with known teams get prediction pages indexed
  const matchRoutes = matches
    .filter((m) => m.stage === "Group Stage" && m.predictionSlug)
    .map((m) => ({
      url: `${baseUrl}/match/${m.predictionSlug}`,
      lastModified: "2026-06-11",
      changeFrequency: "daily" as const,
      priority: 0.8,
    }))

  const teamRoutes = teams.map((t) => ({
    url: `${baseUrl}/team/${t.slug}`,
    lastModified: "2026-06-11",
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }))

  // Club hub + detail pages, from the static snapshot (51 clubs, no DB).
  const clubRoutes: MetadataRoute.Sitemap = getStaticClubsForSitemap().map((c) => {
    let lastModified = "2026-09-19"
    if (c.lastModified) {
      const d = new Date(c.lastModified)
      if (!Number.isNaN(d.getTime())) lastModified = d.toISOString().slice(0, 10)
    }
    return {
      url: `${baseUrl}/clubs/${c.slug}`,
      lastModified,
      changeFrequency: "daily" as const,
      priority: 0.7,
    }
  })

  // Match directory pages (fixed) plus every match detail URL, all from the snapshot.
  const matchDirectoryRoutes = [
    { url: `${baseUrl}/premier-league/matches`, lastModified: "2026-09-19", changeFrequency: "daily" as const, priority: 0.8 },
    { url: `${baseUrl}/champions-league/matches`, lastModified: "2026-09-19", changeFrequency: "daily" as const, priority: 0.8 },
  ]

  const seen = new Set<string>()
  const matchDetailRoutes: MetadataRoute.Sitemap = []
  for (const m of getStaticMatchesForSitemap()) {
    const url = `${baseUrl}${buildMatchUrl(
      { providerFixtureId: m.providerFixtureId, homeTeam: { slug: m.homeTeamSlug }, awayTeam: { slug: m.awayTeamSlug } },
      m.competitionSlug,
    )}`
    if (seen.has(url)) continue
    seen.add(url)
    let lastModified = "2026-09-19"
    if (m.lastModified) {
      const d = new Date(m.lastModified)
      if (!Number.isNaN(d.getTime())) lastModified = d.toISOString().slice(0, 10)
    }
    matchDetailRoutes.push({
      url,
      lastModified,
      changeFrequency: "daily",
      priority: matchSitemapPriority(m.status),
    })
  }

  return [
    ...staticRoutes,
    ...matchRoutes,
    ...teamRoutes,
    { url: `${baseUrl}/clubs`, lastModified: "2026-09-19", changeFrequency: "daily" as const, priority: 0.8 },
    ...clubRoutes,
    ...matchDirectoryRoutes,
    ...matchDetailRoutes,
  ]
}
