"use client"

import { useState } from "react"
import { getTeamCrest, getTeamCrestByTeamId, teamCrestFallbackText } from "@/lib/football/team-crests"

export type TeamCrestSize = "sm" | "md" | "lg" | "xl"

export interface TeamCrestProps {
  /** Team id, used as a secondary lookup when `slug` is unavailable. */
  teamId?: string
  /** Team slug (primary lookup key — the crest file is named after it). */
  slug?: string
  /** Club name, used for the accessible label and the fallback monogram. */
  name: string
  size?: TeamCrestSize
  /** Render the crest eagerly (above the fold); otherwise it lazy-loads. */
  priority?: boolean
  /** When true the crest is purely decorative: empty alt and hidden from AT. */
  decorative?: boolean
}

const SIZE_CLASS: Record<TeamCrestSize, { box: string; text: string }> = {
  sm: { box: "h-8 w-8", text: "text-[10px]" },
  md: { box: "h-9 w-9", text: "text-[11px]" },
  lg: { box: "h-12 w-12", text: "text-sm" },
  xl: { box: "h-16 w-16", text: "text-lg" },
}

/**
 * A localized club crest (or a deterministic monogram fallback) inside a fixed-
 * size container. The fixed box prevents layout shift, `object-contain` keeps
 * the crest's aspect ratio (no stretching, no circular cropping), and the source
 * is always a local `/images/...` path — there is no runtime remote request.
 *
 * Non-Premier-League teams render the monogram immediately, and a localized
 * crest whose file fails to load swaps to the monogram via `onError`, so there
 * is never a broken image.
 */
export function TeamCrest({
  teamId,
  slug,
  name,
  size = "md",
  priority = false,
  decorative = false,
}: TeamCrestProps) {
  const crest =
    (slug ? getTeamCrest(slug) : undefined) ?? (teamId ? getTeamCrestByTeamId(teamId) : undefined) ?? null
  const [loadFailed, setLoadFailed] = useState(false)
  const { box, text } = SIZE_CLASS[size]

  if (crest && !loadFailed) {
    return (
      // A localized static crest served from /public — not a remote host — so
      // next/image's optimizer is unnecessary here.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={crest.localPath}
        alt={decorative ? "" : `${name} crest`}
        width={crest.width ?? undefined}
        height={crest.height ?? undefined}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        onError={() => setLoadFailed(true)}
        className={`${box} inline-block shrink-0 rounded-md bg-muted object-contain`}
      />
    )
  }

  return (
    <span
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : `${name} crest`}
      role={decorative ? undefined : "img"}
      className={`${box} ${text} inline-flex shrink-0 items-center justify-center rounded-md bg-muted font-bold text-muted-foreground`}
    >
      {teamCrestFallbackText(name)}
    </span>
  )
}
