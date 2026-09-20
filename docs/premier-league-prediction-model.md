# Premier League Prediction Model

Version 1.0 — an explainable statistical model, not a large-language-model
predictor.

## Model overview

The model estimates, for a single Premier League match, the probability of a
home win, draw, and away win (1X2), the most-likely scoreline, and a confidence
level, together with a small set of rule-based reasons. It is a pure TypeScript
model with three components combined in this order:

1. **Elo ratings** — a running strength rating per team.
2. **Attack/defense strength** — decaying, shrunk home/away scoring and
   conceding rates.
3. **Poisson score model** — the two teams' expected goals are fed into a
   bivariate Poisson to obtain the full score matrix, from which 1X2
   probabilities and the top scorelines are read.

Every tunable parameter lives in `lib/model/config.ts`; no magic numbers are
scattered through the code. The model is deterministic: it reads no system
clock, no `Date.now()`, and no `Math.random()`, so the same config and the same
history snapshot always produce the same predictions.

## Data sources

Training and evaluation use only completed historical Premier League results
imported from football-data.co.uk `E0.csv` files:

```text
data/history/premier-league/normalized/*.json   (5 seasons)
data/history/premier-league/manifest.json
data/history/premier-league/team-aliases.json
data/football/{competitions,teams,fixtures,manifest}.json   (current snapshot)
```

The model **does not** use:

- betting odds (from the CSV or any API),
- xG, shots, or advanced statistics,
- lineups, injuries, managers, or player valuations,
- third-party predictions or LLM-generated probabilities,
- future results (a match's outcome never informs its own prediction).

## Seasons used

Five complete seasons, 380 matches each (1,900 total):

| Purpose | Season(s)          | Matches |
| ------- | ------------------ | ------: |
| Burn-in | 2021-22            |     380 |
| Tuning  | 2022-23 – 2024-25  |   1,140 |
| Holdout | 2025-26            |     380 |

The split is chronological, never random. The burn-in season warms up the
Elo and strength state. The tuning seasons are used to select parameters. The
holdout season is only evaluated **after** the config is locked.

## Elo

Base rating `initialRating = 1500`. Expected home score from raw ratings:

```text
E_home = 1 / (1 + 10^(-(R_home - R_away) / 400))
```

After a match, ratings update with a K factor scaled by goal margin (a win by
more than one goal moves ratings further, capped at 2.5×):

```text
R' = R + K · (actual - expected)
```

`actual` is 1 / 0.5 / 0 for a home win / draw / home loss. The tuned K is 40.

### Home advantage

A fixed Elo bonus (`homeAdvantage = 50`) is added to the home team **for
prediction only**; it is never written into the stored base rating.

### Season regression

At each season boundary, ratings are pulled toward the league mean by
`seasonRegression`. The tuned value is 0, so this v1 config applies no
regression; it is retained as a configurable knob.

## Attack/defense strength

Each team tracks four decaying aggregates: home goals scored, away goals
scored, home goals conceded, away goals conceded. A strength ratio is the
team's per-match rate divided by the corresponding league-wide rate, then
shrunk toward 1.0 (league average) by a prior-equivalent match count:

```text
ratio = (team_rate / league_rate)
shrunk = (ratio · N + prior) / (N + prior)
```

`N` is the team's observed match count in that bucket. The prior is
`priorStrength × multiplier(tier)`, where the multiplier grows with less
coverage — so a team with little history shrinks hard toward league average.

### Time decay

Aggregates decay exponentially with a fixed half-life (`halfLifeDays = 180`),
computed against each **predicted match date**, never the runtime clock:

```text
w = exp(-ln(2) · Δdays / halfLifeDays)
```

## Poisson score model

Expected goals for the home and away teams:

```text
λ_home = leagueHomeAvg · homeAttack · awayDefense · exp(clamp(eloDiff) · eloToLambda)
λ_away = leagueAwayAvg · awayAttack · homeDefense · exp(-clamp(eloDiff) · eloToLambda)
```

where `eloDiff` includes home advantage and is clamped to `±maxEloDiff`, and
`eloToLambda` (tuned to 0.001) limits how strongly Elo shifts goals. Both λ
values are clamped to `[minLambda, maxLambda]` = `[0.1, 5]`.

The score matrix covers 0–10 goals per side and is re-normalized after
truncation. The 1X2 probabilities are summed from the matrix (they total 100%),
and the top scoreline is the single highest-probability cell, not a
back-derived guess.

## Promotion / low-history fallback

Coverage tiers are derived from a team's observed match count:

| Tier | Observed matches | Treatment |
| ---- | ---------------: | --------- |
| strong | > 114 | normal history |
| medium | 39–114 | extra shrinkage toward league average |
| limited | 1–38 | strong shrinkage, confidence capped at low |
| none | 0 | league-average attack/defense, conservative Elo, high uncertainty |

A `none` team is **not** assumed to lose; it is treated as league-average until
its own current-season results accumulate. The fallback rules are encoded in
`config.ts`.

## Confidence

Confidence is a weighted blend (not just the max probability):

```text
score = 0.45·pMax + 0.20·(1 - entropy) + 0.20·margin + 0.15·sample
```

where `margin` is the gap between the top two outcomes and `sample` reflects
the smaller team's observed-match count. The score maps to `low` / `medium` /
`high` through config thresholds, and the level is hard-capped by the weaker
team's coverage tier (`none`/`limited` → `low`). Confidence never implies a
guarantee.

## Prediction reasons

`lib/model/reasons.ts` emits 3–5 deterministic, traceable reasons per
prediction, each with a stable `code`, plain-English `text`, and numeric
`value` / `comparisonValue`. Sources are limited to real model inputs (Elo
difference, home/away attack and defense rates, expected goals, home
advantage, coverage). Teams with limited or no history always emit:

> Limited Premier League history reduces model confidence.

No injuries, lineups, players, or odds are ever mentioned.

## Backtest methodology

The backtest is strictly chronological and leakage-free:

1. Matches are ordered by date.
2. All matches of a single date are predicted from the state **before** any
   same-day result is absorbed.
3. Only after every same-day prediction is made are that day's results applied
   to update Elo and strength.

This guarantees a match's own result — and any earlier result on the same day —
never influences its prediction. A unit test asserts this directly.

## Accuracy metrics

The metric suite (`lib/model/metrics.ts`) reports 1X2 accuracy, exact-score
accuracy, home/away/total-goals mean absolute error, the fraction of matches
where both teams' expected goals are within ±1 goal, multiclass Brier score,
multiclass log loss, average confidence, and accuracy broken down by confidence
level, by season, and by outcome, plus per-outcome probability calibration
buckets.

### Reference holdout run (2025-26, 380 matches)

| Model | 1X2 Acc | Exact | Brier | Log Loss | Goal MAE |
| ----- | ------: | ----: | ----: | -------: | -------: |
| Always home win | 42.63% | 12.37% | 1.147 | 15.851 | 1.243 |
| League-average Poisson | 42.63% | 12.37% | 0.655 | 1.082 | 1.216 |
| Elo only | 48.16% | 12.37% | 0.625 | 1.041 | 1.227 |
| **Full model (Elo + strength + Poisson)** | **48.95%** | **9.47%** | **0.622** | **1.034** | **1.258** |

The full model improves on every baseline in the probability-quality metrics
(lower log loss and Brier) and in 1X2 accuracy. However, its **exact-score
accuracy and total-goal MAE are no better than (and slightly below) the
trivial baselines** — the model's varying point estimate misses the specific
score more often than always guessing the most common scoreline.

## Known limitations

- **Draws are essentially never predicted as the top outcome.** The most likely
  single scoreline from a Poisson is rarely a draw, so the argmax 1X2 outcome is
  almost always a home or away win even though a non-trivial draw probability is
  reported. In the holdout the model predicted 0 draws; the draw probability is
  still correct in a probabilistic sense (it contributes to log loss).
- **Exact-score accuracy is low (≈9.5%).** Point scoreline predictions are
  inherently hard; the model's strength is probability quality, not exact scores.
- **No "recent 5 matches" feature.** The strength aggregates are decaying, but
  there is no dedicated short-term form signal.
- **No injuries, suspensions, lineups, transfers, or motivation signals.**
- **Limited to Premier League history** — a promoted side with no PL history is
  treated as league-average until its results accumulate.

## Not used / disclaimers

This model uses **no betting odds**, **no injuries/lineups/xG**, and no external
or LLM-generated probabilities. **Historical performance does not guarantee
future results.** Predictions are an output of a statistical model and are not
advice.
