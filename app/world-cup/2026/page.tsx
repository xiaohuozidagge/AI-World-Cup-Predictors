import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight, CalendarDays, Globe, Trophy, Users } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Breadcrumbs } from "@/components/Breadcrumbs"
import { JsonLd, breadcrumbJsonLd } from "@/lib/jsonld"
import { SITE_URL } from "@/lib/constants"

export const metadata: Metadata = {
  title: "World Cup 2026 Archive",
  description:
    "Browse our archived AI-powered World Cup 2026 predictions — match forecasts, winner odds, team profiles and group predictions.",
  alternates: { canonical: "/world-cup/2026" },
  robots: {
    index: false,
    follow: true,
    googleBot: { index: false, follow: true },
  },
  openGraph: {
    title: "World Cup 2026 Archive | AI Predictor",
    description:
      "Browse our archived AI-powered World Cup 2026 predictions — match forecasts, winner odds, team profiles and group predictions.",
    images: [{ url: "/og/world-cup-archive.png", width: 1200, height: 630 }],
  },
}

const breadcrumbs = [
  { name: "Home", url: "/" },
  { name: "World Cup 2026 Archive", url: "/world-cup/2026" },
]

const links = [
  {
    icon: CalendarDays,
    label: "Match Predictions",
    href: "/predictions",
    description: "World Cup 2026 match forecasts and the full watch calendar.",
  },
  {
    icon: Trophy,
    label: "Winner Predictions",
    href: "/winner-predictions",
    description: "Championship odds and title probabilities for all 48 teams.",
  },
  {
    icon: Users,
    label: "Team Profiles",
    href: "/teams",
    description: "All 48 nations with FIFA rankings, key players and form.",
  },
  {
    icon: Globe,
    label: "Group Predictions",
    href: "/2026-world-cup-group-predictions",
    description: "Group-by-group forecasts for the tournament.",
  },
  {
    icon: ArrowRight,
    label: "Match Simulator",
    href: "/simulator",
    description: "Predict any matchup instantly with win probability and score.",
  },
]

export default function WorldCup2026ArchivePage() {
  return (
    <>
      <JsonLd data={breadcrumbJsonLd(breadcrumbs, SITE_URL)} />

      <div className="container mx-auto max-w-7xl px-4 py-12">
        <Breadcrumbs items={breadcrumbs} />

        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">World Cup 2026 Archive</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Our complete World Cup 2026 predictions and analysis are preserved here. Match forecasts, winner odds,
            team profiles and group predictions remain available to browse.
          </p>
        </header>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {links.map((link) => (
            <Link key={link.href} href={link.href} className="group">
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardHeader>
                  <link.icon className="mb-2 h-7 w-7 text-sports-green" />
                  <CardTitle className="group-hover:text-sports-green">{link.label}</CardTitle>
                  <CardDescription>{link.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-sports-green">
                    Open <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                  </span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>

        <p className="mt-8 max-w-2xl text-sm text-muted-foreground">
          Looking for current predictions? Explore our{" "}
          <Link href="/premier-league" className="font-medium text-sports-green hover:underline">
            Premier League predictions
          </Link>
          .
        </p>
      </div>
    </>
  )
}
