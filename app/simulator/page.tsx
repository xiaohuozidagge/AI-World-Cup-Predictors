import type { Metadata } from "next"
import { Suspense } from "react"
import { SimulatorClient } from "./SimulatorClient"

export const metadata: Metadata = {
  title: "World Cup Match Simulator — Predict Any Matchup",
  description: "Select any two teams and get an instant AI prediction. Win probability, predicted score, and analysis for any World Cup 2026 matchup.",
  robots: {
    index: false,
    follow: true,
    googleBot: {
      index: false,
      follow: true,
    },
  },
  openGraph: {
    title: "World Cup Match Simulator — Predict Any Matchup",
    description: "Select any two teams and get an instant AI prediction with win probability and predicted score.",
  },
}

export default function SimulatorPage() {
  return (
    <Suspense fallback={null}>
      <SimulatorClient />
    </Suspense>
  )
}
