import type { Metadata } from "next"
import { Suspense } from "react"
import { PredictionsClient } from "./PredictionsClient"
import { getSyncedDataAsOf } from "@/lib/synced-data"

export const metadata: Metadata = {
  title: "World Cup 2026 Predictions & Watch Calendar — Live Scores & Match Schedule",
  description: "Complete World Cup 2026 match predictions calendar. Live scores, finished results, upcoming kickoff times with countdown, AI predictions, and match analysis.",
  openGraph: {
    title: "World Cup 2026 Predictions & Watch Calendar",
    description: "Live scores, finished results, upcoming kickoff times, and AI predictions for every World Cup 2026 match.",
  },
}

export default function PredictionsPage() {
  // The fixed "now" the calendar classifies against, read from the static
  // archive snapshot so the first screen is byte-stable across builds.
  const referenceTime = getSyncedDataAsOf()
  return (
    <Suspense fallback={null}>
      <PredictionsClient referenceTime={referenceTime} />
    </Suspense>
  )
}
