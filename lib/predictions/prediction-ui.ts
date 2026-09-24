/**
 * Shared presentation mapping for the prediction UI (Phase XI), so confidence
 * and status styling stays consistent across the home, "today", Premier League
 * landing and match detail pages.
 *
 * This module is client-safe: it only imports types, so it can be used from
 * server and client component trees alike. Colour is never the sole signal —
 * every level also carries an explicit text label (`confidenceLabel`) and every
 * status carries a label + description (`predictionStatusMeta`).
 */
import type { ConfidenceLevel } from "../model/types"

export type ConfidenceBadgeVariant = "secondary" | "info" | "success"

/**
 * Low = neutral (secondary), Medium = emphasis (info), High = stronger (success).
 * A higher confidence is a stronger visual emphasis, never a "green means
 * guaranteed" signal — the label text always says the confidence level.
 */
export const CONFIDENCE_BADGE_VARIANTS: Record<ConfidenceLevel, ConfidenceBadgeVariant> = {
  low: "secondary",
  medium: "info",
  high: "success",
}

export function confidenceBadgeVariant(level: ConfidenceLevel): ConfidenceBadgeVariant {
  return CONFIDENCE_BADGE_VARIANTS[level]
}
