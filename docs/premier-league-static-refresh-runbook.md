# Premier League Static Refresh — Runbook

This runbook covers the in-season pipeline that keeps the static Premier League
snapshot current: pulling latest results from football-data.org, settling the
frozen predictions, and (once enabled) committing and deploying the refresh via
GitHub Actions.

## 1. What this pipeline does

```
football-data.org v4 ──► validate ──► diff vs data/football ──► optional apply
                                                                    │
                                                                    ▼
data/evaluations/premier-league/2026-27/  ◄── prediction settlement (read-only)
                                                                    │
                                                                    ▼
                          verify ──► (optional) commit ──► (optional) build + deploy
```

It **only** mutates `data/football/fixtures.json`, `data/football/manifest.json`
and `data/evaluations/premier-league/2026-27/`. The prediction artifacts, model,
history and synced directories are read-only inputs.

## 2. Data sources and season

- Source: `GET https://api.football-data.org/v4/competitions/PL/matches`.
- Token: `FOOTBALL_DATA_API_KEY` (never read from any other variable, never logged).
- Season: derived from `data/football/competitions.json` `current_season` — **not
  hardcoded**. The PL competition is `provider_competition_id: 2021`, internal id
  `cb5d6d33-9375-49f5-8cbd-d59754222a97`, label `2026-27`.

## 3. Prerequisites

- Node 20+ and `npm ci` in a clean checkout.
- For a live run: `FOOTBALL_DATA_API_KEY` exported (or seeded via `.env.sync` —
  see `.env.sync.example`).
- For an offline run: a fixture JSON file passed with `--source-file`.

## 4. Local dry-run (no write)

```bash
npm run football:pl:sync:dry-run
# offline:
npm run football:pl:sync:dry-run -- --source-file=fixtures-snapshot.json
```

Prints the diff report, proves the target files are byte-identical before/after,
and never writes.

## 5. Local apply (explicit write)

```bash
npm run football:pl:sync -- --apply
```

`--apply` is the only path that writes. It validates, builds an in-memory
snapshot, writes temp files, re-reads and re-parses them, then atomically
renames over the real files, then re-verifies.

## 6. Verification gates

```bash
npm run football:pl:verify        # 20 teams / 380 fixtures / prediction join / score consistency
npm run verify:static-football    # snapshot integrity
npm run predictions:pl:verify     # prediction invariants
npm run predictions:pl:verify-seal
npm run predictions:pl:evaluate   # settlement overlay (deterministic)
```

All must pass before any commit/deploy.

## 7. Offline mode

`--source-file=<path>` accepts an array or `{ "matches": [...] }` and skips the
network entirely. Tests never depend on the network or a real token.

## 8. Match identity rules

- Identity = the stable `provider_fixture_id` only (never array position, team
  name, kickoff order or slug guessing).
- API and local provider-id sets must be **exactly equal** — no auto add/remove.
- `homeTeam`/`awayTeam` ids, `competition = PL`, 20 teams, and matchday range
  (1–38) must all be consistent. Slug and local match id are immutable.
- Any identity mismatch stops the whole batch.

## 9. Status transitions and score handling

- Allowed transitions are a fixed allowlist (`SCHEDULED→TIMED/LIVE/POSTPONED/…`,
  `LIVE→HALFTIME/FINISHED`, `POSTPONED→TIMED`, etc.). `FINISHED` and `CANCELLED`
  are terminal.
- A final score is written **only** when the API reports `FINISHED`/`AWARDED`;
  `IN_PLAY`/`PAUSED` are never treated as final.
- A `FINISHED` score that differs from the committed one is **not** auto-overridden:
  it is reported as `FINISHED_SCORE_CORRECTION_REQUIRED` and blocks apply pending
  manual confirmation.
- Unknown status, a regressed FINISHED, a cleared final score, a score conflict,
  a count decrease, a non-PL match mixed in, a duplicate, or a non-integer/negative
  score are hard failures.

## 10. Prediction settlement

Categories in `data/evaluations/premier-league/2026-27/`:

- **A — Original backtests (40)**: never official.
- **B — Historical reconstruction (10)**: never official.
- **C — Official sealed (330)**: official only when sealed candidate AND
  `sealedAt < kickoff` AND `publishedAt < kickoff` AND `FINISHED` with a complete
  score AND the seal hash verifies AND not `CANCELLED`/`VOID`.

Zero samples report `null` accuracy, never `0%`. Until publication,
`publishedPredictionCount = 0` and `officialAccuracy = null`.

## 11. Enabling the GitHub Actions pipeline

The workflow `update-premier-league.yml` ships disabled. To enable it:

1. Add the repository secrets `FOOTBALL_DATA_API_KEY` (and, for deploy,
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) under Settings →
   Secrets and variables → Actions → Secrets.
2. Set the repository **variable** `AUTO_REFRESH_ENABLED` to `"true"` under
   Settings → Secrets and variables → Actions → Variables. The workflow reads
   `vars.AUTO_REFRESH_ENABLED`; a missing variable evaluates empty and disables
   refresh, so the flag is never hardcoded in the file.
3. (Optional) set `AUTO_DEPLOY_ENABLED` to `"true"` and `CLOUDFLARE_PAGES_PROJECT`
   to the Cloudflare Pages project name, likewise as repository variables.
4. `workflow_dispatch` stays a dry-run unless the `apply` input is `"true"`.
   Scheduled runs only apply when `vars.AUTO_REFRESH_ENABLED == "true"`.

## 12. Deployment

Deployment is a placeholder until explicitly enabled:

```bash
npx wrangler pages deploy out --project-name="$CLOUDFLARE_PAGES_PROJECT"
```

It runs only when `AUTO_DEPLOY_ENABLED == "true"`, all verifies passed, and there
is a committed data change. `wrangler` is pinned in `package.json`/`wrangler.jsonc`.

## 13. Failure handling and rollback

- Hard failure / correction → apply is refused; no partial write occurs.
- To roll back a bad commit: `git revert` the `chore(data): refresh Premier League results` commit.
- Re-run the dry-run with `--source-file` against the offending payload to inspect
  the exact diff before deciding.

## 14. Forbidden operations

Never modify: `data/predictions/premier-league/2026-27/`, `data/model/`,
`data/history/`, `data/synced/`. Never re-run the model / regenerate predictions /
re-seal / change probabilities, scores, reasons or confidence / change `sealedAt`
/ backfill `publishedAt` / convert a finished sealed prediction to a backtest /
restore Champions League / update World Cup archive data. The commit allowlist
excludes these paths by construction.

## 15. Quick reference

| Action | Command |
| --- | --- |
| Live dry-run | `npm run football:pl:sync:dry-run` |
| Offline dry-run | `npm run football:pl:sync:dry-run -- --source-file=<file>` |
| Apply | `npm run football:pl:sync -- --apply` |
| Verify fixtures | `npm run football:pl:verify` |
| Settle predictions | `npm run predictions:pl:evaluate` |
| Run the test suites | `npm run test:fixture-sync && npm run test:evaluation && npm run test:workflow` |
| Manual dispatch | Actions → *Refresh Premier League results* → set `apply` |
