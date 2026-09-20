/**
 * Deterministic, rule-based prediction reasons. No LLM, no fabricated facts, no
 * external data. Each reason carries a stable `code`, a plain-English `text`,
 * and numeric `value` / `comparisonValue` so the surface can render the same
 * reason without regenerating text. Limited-history teams always emit the
 * mandated "Limited Premier League history reduces model confidence." reason.
 */

import type { ModelConfig } from "./config"
import type { CoverageTier, OneX2Probabilities, Reason, Result, TeamStrengthView } from "./types"

export interface ReasonContext {
  homeSlug: string
  awaySlug: string
  eloHome: number
  eloAway: number
  /** Home-minus-away rating gap, WITHOUT home advantage. */
  rawEloDiff: number
  /** Home-minus-away gap WITH home advantage (used for λ). */
  eloDiff: number
  homeAdvantage: number
  homeStrength: TeamStrengthView
  awayStrength: TeamStrengthView
  leagueHomeAvg: number
  leagueAwayAvg: number
  lambdaHome: number
  lambdaAway: number
  probabilities: OneX2Probabilities
  predictedResult: Result
}

/** "man-utd-fc" → "Man Utd FC" (best-effort label, no name table needed). */
function slugLabel(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => {
      if (part === "fc") return "FC"
      if (part === "afc") return "AFC"
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(" ")
}

const LIMIT_THRESHOLD = 38

interface Candidate {
  code: string
  text: string
  value: number
  comparisonValue: number
  salience: number
}

export function generateReasons(ctx: ReasonContext, config: ModelConfig): Reason[] {
  const home = slugLabel(ctx.homeSlug)
  const away = slugLabel(ctx.awaySlug)
  const candidates: Candidate[] = []

  const rawDiff = ctx.rawEloDiff
  if (rawDiff >= 50) {
    candidates.push({
      code: "ELO_ADVANTAGE_HOME",
      text: `Elo rating favours ${home} (${ctx.eloHome.toFixed(0)} vs ${away} ${ctx.eloAway.toFixed(0)}).`,
      value: ctx.eloHome,
      comparisonValue: ctx.eloAway,
      salience: rawDiff / 400,
    })
  } else if (rawDiff <= -50) {
    candidates.push({
      code: "ELO_ADVANTAGE_AWAY",
      text: `Elo rating favours ${away} (${ctx.eloAway.toFixed(0)} vs ${home} ${ctx.eloHome.toFixed(0)}).`,
      value: ctx.eloAway,
      comparisonValue: ctx.eloHome,
      salience: -rawDiff / 400,
    })
  }

  if (ctx.homeStrength.homeAttack > 1.05) {
    candidates.push({
      code: "HOME_ATTACK",
      text: `${home} score above the league average at home (${ctx.homeStrength.homeAttack.toFixed(2)}× league rate).`,
      value: ctx.homeStrength.homeAttack,
      comparisonValue: 1,
      salience: ctx.homeStrength.homeAttack - 1,
    })
  }
  if (ctx.awayStrength.awayAttack > 1.05) {
    candidates.push({
      code: "AWAY_ATTACK",
      text: `${away} score above the league average away (${ctx.awayStrength.awayAttack.toFixed(2)}× league rate).`,
      value: ctx.awayStrength.awayAttack,
      comparisonValue: 1,
      salience: ctx.awayStrength.awayAttack - 1,
    })
  }
  if (ctx.awayStrength.awayDefense > 1.05) {
    candidates.push({
      code: "AWAY_DEFENSE_WEAK",
      text: `${away} concede above the league average away (${ctx.awayStrength.awayDefense.toFixed(2)}× league rate).`,
      value: ctx.awayStrength.awayDefense,
      comparisonValue: 1,
      salience: ctx.awayStrength.awayDefense - 1,
    })
  }
  if (ctx.homeStrength.homeDefense > 1.05) {
    candidates.push({
      code: "HOME_DEFENSE_WEAK",
      text: `${home} concede above the league average at home (${ctx.homeStrength.homeDefense.toFixed(2)}× league rate).`,
      value: ctx.homeStrength.homeDefense,
      comparisonValue: 1,
      salience: ctx.homeStrength.homeDefense - 1,
    })
  }

  candidates.push({
    code: "EXPECTED_GOALS",
    text: `Model expected goals: ${home} ${ctx.lambdaHome.toFixed(2)} vs ${away} ${ctx.lambdaAway.toFixed(2)}.`,
    value: ctx.lambdaHome,
    comparisonValue: ctx.lambdaAway,
    salience: Math.abs(ctx.lambdaHome - ctx.lambdaAway),
  })

  candidates.push({
    code: "HOME_ADVANTAGE",
    text: `Home advantage adds ${ctx.homeAdvantage.toFixed(0)} Elo points to the home side.`,
    value: ctx.homeAdvantage,
    comparisonValue: 0,
    salience: 0.05,
  })

  const weakerTier: CoverageTier =
    tierRank(ctx.homeStrength.tier) <= tierRank(ctx.awayStrength.tier)
      ? ctx.homeStrength.tier
      : ctx.awayStrength.tier
  const limitedHistory = weakerTier === "limited" || weakerTier === "none"
  const minObserved = Math.min(ctx.homeStrength.matchesObserved, ctx.awayStrength.matchesObserved)

  const limited: Candidate | null = limitedHistory
    ? {
        code: "LIMITED_HISTORY",
        text: "Limited Premier League history reduces model confidence.",
        value: minObserved,
        comparisonValue: LIMIT_THRESHOLD,
        salience: Number.POSITIVE_INFINITY,
      }
    : null

  const budget = config.reasons.maxReasons - (limited ? 1 : 0)
  const chosen = candidates.sort((a, b) => b.salience - a.salience).slice(0, budget)

  const reasons: Reason[] = chosen.map(({ code, text, value, comparisonValue }) => ({
    code,
    text,
    value,
    comparisonValue,
  }))
  if (limited) reasons.push(limited)

  return reasons
}

function tierRank(t: CoverageTier): number {
  return { strong: 3, medium: 2, limited: 1, none: 0 }[t]
}
