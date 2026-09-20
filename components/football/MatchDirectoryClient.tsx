"use client"

import { useSearchParams } from "next/navigation"
import {
  parsePositiveInt,
  parseWhitelistedInt,
  parseWhitelistedString,
  type MatchDirectoryData,
} from "@/lib/football/match-logic"
import { MatchDirectory, type MatchDirectoryView } from "./MatchDirectory"

/**
 * Client wrapper around `<MatchDirectory>` that reads the filter/view/page from
 * the URL query string. It is always rendered inside a `<Suspense>` boundary
 * (see the matches page), so on the prerendered route the Suspense fallback —
 * the default Overview with Upcoming/Results — lands in the static HTML for
 * SEO, and this component replaces it on hydration. Grouping is status-only, so
 * the server and client render are byte-identical without any clock input.
 */
export function MatchDirectoryClient({ data }: { data: MatchDirectoryData }) {
  const searchParams = useSearchParams()

  const matchweek = parseWhitelistedInt(searchParams.get("matchweek"), data.filterOptions.matchweeks)
  const stage = parseWhitelistedString(searchParams.get("stage"), data.filterOptions.stages)
  const page = parsePositiveInt(searchParams.get("page")) ?? 1

  let view: MatchDirectoryView = "overview"
  const viewRaw = searchParams.get("view")
  if (viewRaw === "in-progress" || viewRaw === "upcoming" || viewRaw === "results" || viewRaw === "other") {
    view = viewRaw
  }

  return (
    <MatchDirectory
      data={data}
      view={view}
      page={page}
      filter={{ matchweek, stage }}
    />
  )
}
