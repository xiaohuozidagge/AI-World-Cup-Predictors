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

## v1.1 — draw calibration attempt (rejected)

v1.1 is a calibration upgrade to v1 that adds three knobs — a Dixon–Coles
`rho`, a `drawMassMultiplier`, and a `goalScale` — aimed at the single most
visible v1 weakness: **the model never picks "draw" as the top outcome.** It
was built and validated strictly out-of-sample, and it was **rejected** by its
own pre-registered acceptance criteria (see below). v1 remains the current
baseline.

### Why independent Poisson under-predicts draws

The score model treats the two teams' goal counts as **independent** Poissons
and multiplies their marginals into a score matrix. Independence forces the
low-scoring cells that both sides land on (0-0, 1-1) to be products of separate
events, but real low-scoring matches show positive dependence — teams that
grind out a tight game push toward 0-0/1-1 together. The result is that the
model's aggregate draw probability is slightly too low, and — more importantly
for prediction — the *single most likely scoreline* is often 1-1 while the
aggregate draw probability is still below the home and away win probabilities.

This is the key distinction behind "0 predicted draws":

- The **top scoreline** is a single cell; 1-1 is frequently the largest cell,
  and in the 2024-25 validation the model's top scoreline was 1-1 in 202 of 380
  matches.
- The **1X2 outcome** is an *aggregate*: home-win mass (all cells `i > j`) vs
  draw mass (the diagonal sum `i = j`) vs away-win mass (all `i < j`). The
  diagonal is split across 0-0, 1-1, 2-2, … so even though 1-1 is the biggest
  single cell, the summed draw probability (~21%) stays below the summed home
  (~43%) or away (~36%) probability in essentially every match. The argmax
  therefore never lands on "draw".

### Dixon–Coles correction (`rho`)

The Dixon–Coles low-score correction re-weights exactly four cells after the
raw Poisson matrix is built:

```text
τ(0,0) = 1 − λ_home · λ_away · rho
τ(0,1) = 1 + λ_home · rho
τ(1,0) = 1 + λ_away · rho
τ(1,1) = 1 − rho
```

With `rho < 0` (the searched direction), 0-0 and 1-1 are boosted and 0-1/1-0
are reduced. `rho = 0` reproduces plain Poisson exactly. Any correction that
would produce a negative cell is rejected rather than silently clamped.

### Draw mass calibration (`drawMassMultiplier`)

After Dixon–Coles, every diagonal cell (0-0, 1-1, 2-2, …) is multiplied by
`drawMassMultiplier`, then the **whole** matrix is re-normalized so the cells
sum to 1. The 1X2 probabilities, the top scoreline, and the top-3 scorelines
are all read from this final matrix, so `draw probability = Σ diagonal` holds
by construction. A value of 1 is neutral; a value above 1 raises the draw mass.

### Goal scale (`goalScale`)

`goalScale` multiplies `λ_home` and `λ_away` (uniformly, never per-team) before
the matrix is built, then both are re-clamped to `[minLambda, maxLambda]`. A
value of 1 is neutral.

### v1.1 data partition

| Purpose            | Season          | Status              |
| ------------------ | --------------- | ------------------- |
| Burn-in            | 2021-22         | initialization      |
| Tuning             | 2022-23 – 2023-24 | parameter selection |
| Validation         | 2024-25         | accept/reject       |
| Exposed comparison | 2025-26         | post-hoc only       |

### Why 2025-26 is no longer an untouched holdout for v1.1

v1 treated 2025-26 as a genuinely untouched holdout. By the time v1.1 was
developed, 2025-26 results had already been seen and reported during v1
evaluation, so it can no longer be considered out-of-sample. v1.1 therefore
uses 2024-25 as its single accept/reject validation season, and treats 2025-26
only as an **exposed, post-hoc comparison** — it is never used to select
parameters, and it would only have been run at all had validation passed.

### Validation acceptance criteria (fixed before running)

1. Predicted draw count must be > 0.
2. Draw recall must be > 0.
3. Every prediction's probabilities must be in [0, 1] and sum to 1.
4. Log loss on 2024-25 must not worsen v1's by more than 0.01.
5. Brier on 2024-25 must not worsen v1's by more than 0.01.
6. Must not "improve" by predicting a majority of matches as draws.
7. The predicted outcome distribution must not collapse to a single category.
8. Confidence must remain roughly monotonic with accuracy.

### Validation outcome — rejected

The log-loss-optimal config within the allowed grid (`rho = -0.05`,
`drawMassMultiplier = 1`, `goalScale = 1.05`) predicted **0 draws** and thus
failed criteria 1 and 2 (draw count 0, draw recall 0). It passed every other
criterion: probabilities valid, log loss within 0.0002 of v1, Brier within
0.0002, no majority-draw degeneracy, two predicted outcome categories (H=247,
A=133), and roughly monotonic confidence. The verdict is **REJECTED**, so v1
stays the baseline and no production predictions are generated from v1.1.

The root cause is the aggregate-vs-cell distinction above: within a calibration
budget small enough to preserve v1's log loss and Brier, no match's draw
probability rises above both the home and away win probabilities, so the argmax
never selects "draw". Draws *can* be forced to the top (the grid contains
configs predicting up to 134 draws), but only by boosting draw mass far enough
to materially worsen log loss and Brier — which the acceptance criteria forbid.

### Prospective accuracy principle

Backtest and validation metrics describe **historical** performance on data the
model has effectively already seen. They are a diagnostic, not a claim of
future success. Official accuracy for this model begins only from the
**2026-27 predictions that are published and then locked** — the model's true
out-of-sample record is whatever those published predictions achieve, measured
against results as they actually occur. No retrospective backtest is ever
relabeled as a published prediction.

## v1.2 — per-match draw model (rejected)

v1.2 is a second attempt at the same v1 weakness that v1.1 failed to fix — the
model never picks "draw" as the argmax 1X2 outcome. Where v1.1 tried to nudge
the whole score matrix with three calibration knobs, v1.2 replaces that
approach with a **dedicated per-match draw-probability model** stacked on top
of the frozen v1 score matrix. It was built and validated strictly
out-of-sample and it was **rejected** by its own pre-registered acceptance
criteria. v1 remains the current baseline.

### Design

A lightweight, deterministic, **L2-regularized logistic regression** estimates
a per-match draw probability `qDraw` from strictly pre-match information, and
that probability is imposed on the v1 score matrix so that draw mass is no
longer a side effect of the independent-Poisson marginals. Everything else
about v1 is frozen: the Elo, strength, coverage, λ, confidence, and reasons
blocks are byte-for-byte unchanged, and v1.2 starts from the v1 raw matrix
(`rho = 0`, `drawMassMultiplier = 1`, `goalScale = 1` — no `calibration` field).

```text
qDraw = sigmoid(β₀ + Σ βᵢ · zᵢ)          # zᵢ = standardized pre-match feature
diagonalScale      = qDraw / baseDraw
nonDiagonalScale   = (1 − qDraw) / (1 − baseDraw)
```

Every diagonal cell is multiplied by `diagonalScale`, every non-diagonal cell
by `nonDiagonalScale`, and the matrix is re-normalized numerically. This
preserves the internal ratios of the diagonal and non-diagonal cells and the
home/away relative relation, forces the draw probability to equal `qDraw`
exactly, keeps `H + D + A = 1`, and leaves the top scoreline / top-3 and
`predictedOutcome == argmax` read off the final matrix. The only tolerance is
`epsilon = 1e-12`.

### Data partition

Five complete seasons, 380 matches each, partitioned chronologically:

| Purpose             | Season   | Use                                                        |
| ------------------- | -------- | ---------------------------------------------------------- |
| Burn-in             | 2021-22  | warm Elo/strength/feature state                             |
| Training            | 2022-23  | fit the 12 logistic-regression candidates                   |
| Selection           | 2023-24  | choose feature set + L2                                     |
| Development         | 2024-25  | exposed benchmark (no re-selection)                          |
| Locked validation   | 2025-26  | run exactly once, after freeze                              |

2025-26 is strictly absent from training, selection, and development. Before
the 2025-26 run, the final config hash, the acceptance thresholds, and the
partition were written to `pre-registration.json`; the validate script
reproduces them verbatim and applies the criteria exactly once, with no
re-tuning after the result is seen.

### Features

23 allowed pre-match features, all drawn from history that exists before the
match, grouped into three nested sets (A ⊂ B ⊂ C):

- **A (6)** — base: absolute Elo difference, total expected goals `λ_home +
  λ_away`, absolute λ difference, the v1 base draw probability, and the home /
  away data-coverage counts.
- **B (15)** — A plus recent-5 for each team and the league: draw rate, average
  total goals, and average absolute goal difference (using fewer than 5
  available matches when history is short).
- **C (23)** — B plus season-to-date: home/away goals for and against,
  goal-scoring difference, goal-conceding difference, an insufficient-sample
  flag, and a promoted / no-prior-data flag.

Teams with no history use explicit league-neutral defaults (never future
means); standardization statistics are computed from training rows only; and
the backtest predicts all same-day matches before absorbing any of that day's
results, so no feature can leak a match's own outcome.

### Selection and result

The grid is 3 feature sets × 4 L2 values (`0.01, 0.1, 1, 10`) = 12 candidates,
selected by log loss → Brier → draw Brier → fewer parameters. The winner is
**feature set A with L2 = 1**, refit on 2022-23 + 2023-24 (760 matches) and
benchmarked on 2024-25.

The winner was **rejected** on the locked 2025-26 validation:

| Gate | Required | v1.2 on 2025-26 | Verdict |
| ---- | -------- | --------------- | ------- |
| Predicted draws | ≥ 19 (5%) | 0 | ✗ FAIL |
| Draw recall | ≥ 0.10 | 0.0000 | ✗ FAIL |
| Draw precision | ≥ 0.20 | NaN (no predictions) | ✗ FAIL |
| Draw F1 | ≥ 0.13 | NaN | ✗ FAIL |
| Draw-prob gap (draws vs non-draws) | > 0.01 | 0.0004 | ✗ FAIL |
| Draw Brier vs v1 | ≤ +0.005 | +0.0002 | ✓ pass |
| Log loss vs v1 | ≤ +0.01 | −0.0001 | ✓ pass |
| Brier vs v1 | ≤ +0.01 | −0.0001 | ✓ pass |
| 1X2 accuracy vs v1 | ≥ −2pp | 0.00pp | ✓ pass |
| No single-category collapse | ≥ 2 outcomes | H=255, D=0, A=125 | ✓ pass |

### Root cause

The honest tension sits between §六's **log-loss-first** selection rule and
§八's **≥ 19 predicted draws** requirement. Draws (~25% base rate) are only
weakly separable by the allowed pre-match features, so the L2-regularized
logistic regression — selected to minimize log loss — shrinks toward its
intercept (`β₀ ≈ −1.25`), yielding a near-constant `qDraw ≈ 0.22` that never
rises above ~0.35. The argmax 1X2 outcome therefore never lands on "draw".
Configs that *do* predict draws (the low-L2 cells of the grid predict up to 18
draws in selection) pay for it in log loss and Brier, so the log-loss-first
rule never selects them. v1.2 slightly improves draw calibration (its draw
probabilities sit closer to the true draw rate than v1's) but produces **zero
argmax draws**, exactly like v1 and v1.1.

### Verdict — rejected

`REJECTED — 继续保留 v1，不生成正式预测`. v1 stays the baseline. No 2026-27
predictions are generated, no deployment, and no commit/push/deploy is
performed from v1.2.

## Not used / disclaimers

This model uses **no betting odds**, **no injuries/lineups/xG**, and no external
or LLM-generated probabilities. **Historical performance does not guarantee
future results.** Predictions are an output of a statistical model and are not
advice.
