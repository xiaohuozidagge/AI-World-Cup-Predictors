/**
 * Team attack/defense strength estimation with exponential time decay and
 * Bayesian-style shrinkage toward the league average. Pure and deterministic.
 *
 * For each team we track four decaying goal aggregates (home-scored, away-scored,
 * home-conceded, away-conceded). A strength ratio is the team's weighted
 * per-match rate divided by the corresponding league-wide rate; it is then
 * shrunk toward 1.0 by a tier-specific prior (teams with little history shrink
 * hard, so a "none"/"limited" team is effectively league average).
 */

import type { ModelConfig } from "./config"
import type { CoverageTier, LeagueState, TeamStrengthState, TeamStrengthView } from "./types"

/** The four aggregates that make up a team's strength state. */
export const EMPTY_STRENGTH: TeamStrengthState = {
  homeForWeight: 0,
  homeForCount: 0,
  awayForWeight: 0,
  awayForCount: 0,
  homeAgainstWeight: 0,
  homeAgainstCount: 0,
  awayAgainstWeight: 0,
  awayAgainstCount: 0,
  matchesObserved: 0,
}

export const EMPTY_LEAGUE: LeagueState = { homeGoalsWeight: 0, awayGoalsWeight: 0, weight: 0 }

/** Multiply every decaying aggregate by a decay factor (advancing the clock). */
export function decayState(
  strength: Record<string, TeamStrengthState>,
  league: LeagueState,
  factor: number,
): void {
  for (const slug of Object.keys(strength)) {
    const s = strength[slug]
    s.homeForWeight *= factor
    s.homeForCount *= factor
    s.awayForWeight *= factor
    s.awayForCount *= factor
    s.homeAgainstWeight *= factor
    s.homeAgainstCount *= factor
    s.awayAgainstWeight *= factor
    s.awayAgainstCount *= factor
    // matchesObserved is a raw count and must NOT decay.
  }
  league.homeGoalsWeight *= factor
  league.awayGoalsWeight *= factor
  league.weight *= factor
}

/** Record a finished match into the team and league aggregates (weight = 1). */
export function updateStrengthAfterMatch(
  strength: Record<string, TeamStrengthState>,
  league: LeagueState,
  homeSlug: string,
  awaySlug: string,
  homeGoals: number,
  awayGoals: number,
): void {
  const home = strength[homeSlug] ?? (strength[homeSlug] = { ...EMPTY_STRENGTH })
  const away = strength[awaySlug] ?? (strength[awaySlug] = { ...EMPTY_STRENGTH })

  home.homeForWeight += homeGoals
  home.homeForCount += 1
  home.homeAgainstWeight += awayGoals
  home.homeAgainstCount += 1
  home.matchesObserved += 1

  away.awayForWeight += awayGoals
  away.awayForCount += 1
  away.awayAgainstWeight += homeGoals
  away.awayAgainstCount += 1
  away.matchesObserved += 1

  league.homeGoalsWeight += homeGoals
  league.awayGoalsWeight += awayGoals
  league.weight += 1
}

/** Coverage tier from the raw (undecayed) number of observed matches. */
export function coverageTierFor(matchesObserved: number, config: ModelConfig): CoverageTier {
  if (matchesObserved <= 0) return "none"
  if (matchesObserved <= config.coverage.limitedMaxMatches) return "limited"
  if (matchesObserved <= config.coverage.mediumMaxMatches) return "medium"
  return "strong"
}

/** Shrink a raw ratio toward 1.0 by a prior-equivalent match count. */
function shrink(ratio: number, effectiveN: number, prior: number): number {
  return (ratio * effectiveN + prior) / (effectiveN + prior)
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 1
}

/** Compute a team's shrunk strength ratios from the current state. */
export function teamStrengthView(
  strength: Record<string, TeamStrengthState>,
  league: LeagueState,
  slug: string,
  config: ModelConfig,
): TeamStrengthView {
  const s = strength[slug] ?? EMPTY_STRENGTH

  const leagueHomeAvg = league.weight > 0 ? league.homeGoalsWeight / league.weight : config.lambda.leagueHomeGoals
  const leagueAwayAvg = league.weight > 0 ? league.awayGoalsWeight / league.weight : config.lambda.leagueAwayGoals

  const rawHomeAttack = safeRatio(s.homeForWeight / Math.max(s.homeForCount, 1), leagueHomeAvg)
  const rawAwayAttack = safeRatio(s.awayForWeight / Math.max(s.awayForCount, 1), leagueAwayAvg)
  const rawHomeDefense = safeRatio(s.homeAgainstWeight / Math.max(s.homeAgainstCount, 1), leagueAwayAvg)
  const rawAwayDefense = safeRatio(s.awayAgainstWeight / Math.max(s.awayAgainstCount, 1), leagueHomeAvg)

  const tier = coverageTierFor(s.matchesObserved, config)
  const prior = config.strength.priorStrength * config.strength.priorStrengthMultiplier[tier]

  const homeAttack = s.homeForCount > 0 ? shrink(rawHomeAttack, s.homeForCount, prior) : 1
  const awayAttack = s.awayForCount > 0 ? shrink(rawAwayAttack, s.awayForCount, prior) : 1
  const homeDefense = s.homeAgainstCount > 0 ? shrink(rawHomeDefense, s.homeAgainstCount, prior) : 1
  const awayDefense = s.awayAgainstCount > 0 ? shrink(rawAwayDefense, s.awayAgainstCount, prior) : 1

  return {
    homeAttack,
    awayAttack,
    homeDefense,
    awayDefense,
    matchesObserved: s.matchesObserved,
    tier,
  }
}
