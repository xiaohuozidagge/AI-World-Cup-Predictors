/**
 * Guard-rail assertions over `.github/workflows/update-premier-league.yml`.
 *
 * These read the workflow *text* (nothing is executed) so a future edit cannot
 * silently re-enable auto-deploy, hardcode a toggle or secret, widen the commit
 * allowlist, resurrect the retired Supabase/CL sync, or make the three jobs
 * assume a shared filesystem (GitHub Actions jobs run on separate runners and
 * must hand data over as hash-anchored artifacts).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const WORKFLOW_PATH = join(process.cwd(), ".github", "workflows", "update-premier-league.yml")
const yml = readFileSync(WORKFLOW_PATH, "utf8")

// --- structural helpers ------------------------------------------------------

/** The `on:` block (before `jobs:`). */
function onBlock(): string {
  return yml.slice(yml.indexOf("on:"), yml.indexOf("jobs:"))
}

/** The `jobs:` section, sliced to just after the `jobs:` marker. */
function jobsSection(): string {
  return yml.slice(yml.indexOf("jobs:"))
}

/** Map of job name → its YAML block (job names are the 2-space keys under `jobs:`). */
function jobBlocks(): Record<string, string> {
  const section = jobsSection()
  const blocks: Record<string, string> = {}
  const re = /\n  ([a-z][a-z0-9_-]*):\n/g
  const starts: Array<{ name: string; index: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(section)) !== null) starts.push({ name: m[1], index: m.index })
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].index : section.length
    blocks[starts[i].name] = section.slice(starts[i].index, end)
  }
  return blocks
}

const jobs = jobBlocks()

// --- triggers & schedule -----------------------------------------------------

test("workflow never listens to push (no auto-commit recursion)", () => {
  assert.ok(!/^on:\s*[\s\S]*?\n\s+push:/m.test(yml), "on: block must not contain a push trigger")
  assert.ok(!onBlock().includes("\n  push:"), "on: block must not contain a push trigger")
})

test("schedule uses the pinned Beijing-time cron", () => {
  assert.ok(yml.includes("17 0,6,12,18 * * *"), "schedule cron must be the pinned 17 0,6,12,18 * * *")
})

test("concurrency prevents parallel updates", () => {
  assert.ok(yml.includes("concurrency:"), "must declare concurrency")
  assert.ok(yml.includes("cancel-in-progress: false"), "must not cancel an in-flight update")
})

// --- toggles: vars not hardcoded --------------------------------------------

test("safety toggles are read from vars.*, never hardcoded", () => {
  assert.ok(!yml.includes('AUTO_REFRESH_ENABLED: "false"'), "must not hardcode AUTO_REFRESH_ENABLED=false")
  assert.ok(!yml.includes('AUTO_DEPLOY_ENABLED: "false"'), "must not hardcode AUTO_DEPLOY_ENABLED=false")
  assert.ok(!yml.includes('CLOUDFLARE_PAGES_PROJECT: ""'), "must not hardcode CLOUDFLARE_PAGES_PROJECT=\"\"")
  assert.ok(yml.includes("vars.AUTO_REFRESH_ENABLED"), "must read vars.AUTO_REFRESH_ENABLED")
  assert.ok(yml.includes("vars.AUTO_DEPLOY_ENABLED"), "must read vars.AUTO_DEPLOY_ENABLED")
  assert.ok(yml.includes("vars.CLOUDFLARE_PAGES_PROJECT"), "must read vars.CLOUDFLARE_PAGES_PROJECT")
})

test("a manual apply=true is refused when AUTO_REFRESH_ENABLED is not true", () => {
  assert.ok(
    jobs.refresh.includes("AUTO_REFRESH_ENABLED is not true"),
    "refresh must warn and fall back to dry-run when apply is requested but refresh is disabled",
  )
})

// --- permissions -------------------------------------------------------------

test("top-level permissions default to contents: read", () => {
  const permBlock = yml.slice(yml.indexOf("\npermissions:\n"), yml.indexOf("\njobs:\n"))
  assert.ok(permBlock.includes("contents: read"), "top-level permissions must be contents: read")
  assert.ok(!permBlock.includes("contents: write"), "top-level permissions must not grant write")
})

test("only the commit job holds contents: write", () => {
  assert.ok(jobs.commit.includes("contents: write"), "commit job must declare its own write scope")
  assert.ok(!jobs.refresh.includes("contents: write"), "refresh job must not grant write")
  assert.ok(!jobs.deploy.includes("contents: write"), "deploy job must not grant write")
})

test("deploy job is contents: read", () => {
  assert.ok(!jobs.deploy.includes("contents: write"))
})

// --- secret isolation --------------------------------------------------------

test("FOOTBALL_DATA_API_KEY is scoped to the refresh job only", () => {
  assert.ok(jobs.refresh.includes("secrets.FOOTBALL_DATA_API_KEY"), "refresh must reference the football-data token")
  assert.ok(!jobs.commit.includes("FOOTBALL_DATA_API_KEY"), "commit must not see the football-data token")
  assert.ok(!jobs.deploy.includes("FOOTBALL_DATA_API_KEY"), "deploy must not see the football-data token")
})

test("Cloudflare secrets are scoped to the deploy job only", () => {
  assert.ok(jobs.deploy.includes("secrets.CLOUDFLARE_API_TOKEN"), "deploy must reference CLOUDFLARE_API_TOKEN")
  assert.ok(jobs.deploy.includes("secrets.CLOUDFLARE_ACCOUNT_ID"), "deploy must reference CLOUDFLARE_ACCOUNT_ID")
  assert.ok(!jobs.refresh.includes("CLOUDFLARE_API_TOKEN"), "refresh must not see Cloudflare secrets")
  assert.ok(!jobs.refresh.includes("CLOUDFLARE_ACCOUNT_ID"), "refresh must not see Cloudflare secrets")
  assert.ok(!jobs.commit.includes("CLOUDFLARE_API_TOKEN"), "commit must not see Cloudflare secrets")
})

test("no plaintext secret is inlined", () => {
  assert.ok(!/FOOTBALL_DATA_API_KEY:\s*["']/.test(yml), "FOOTBALL_DATA_API_KEY must not hold a literal")
  assert.ok(!/CLOUDFLARE_API_TOKEN:\s*["']/.test(yml), "CLOUDFLARE_API_TOKEN must not hold a literal")
  assert.ok(!/CLOUDFLARE_ACCOUNT_ID:\s*["']/.test(yml), "CLOUDFLARE_ACCOUNT_ID must not hold a literal")
})

// --- cross-job data passing --------------------------------------------------

test("jobs hand data over as artifacts, not a shared filesystem", () => {
  assert.ok(jobs.refresh.includes("actions/upload-artifact@v4"), "refresh must upload artifacts")
  assert.ok(jobs.commit.includes("actions/download-artifact@v4"), "commit must download the data artifact")
  assert.ok(jobs.deploy.includes("actions/download-artifact@v4"), "deploy must download the static export")
})

test("job dependency graph is refresh → commit → deploy", () => {
  assert.ok(jobs.commit.includes("needs: refresh"), "commit must depend on refresh")
  assert.ok(jobs.deploy.includes("needs: [refresh, commit]"), "deploy must depend on refresh and commit")
})

test("the two artifacts carry only their allowlisted contents", () => {
  assert.ok(jobs.refresh.includes("name: premier-league-data-update"), "data artifact must be named premier-league-data-update")
  assert.ok(jobs.refresh.includes("name: static-export"), "static artifact must be named static-export")
  assert.ok(jobs.refresh.includes("data/football/fixtures.json"), "data artifact must carry fixtures.json")
  assert.ok(jobs.refresh.includes("data/football/manifest.json"), "data artifact must carry manifest.json")
  assert.ok(jobs.refresh.includes("data/evaluations/premier-league/2026-27/"), "data artifact must carry the settlement overlay")
  assert.ok(jobs.refresh.includes("artifact-manifest.json"), "artifacts must carry artifact-manifest.json")
  assert.ok(jobs.refresh.includes("out/"), "static-export must carry out/")
  // The sync report is a transient hand-off, not a carried artifact file.
  assert.ok(
    !/^[ \t]+sync-diff-report\.json[ \t]*$/m.test(jobs.refresh),
    "data artifact must not list sync-diff-report.json as a carried file",
  )
})

test("the sync report is written to the runner temp dir, never the repo root", () => {
  assert.ok(jobs.refresh.includes("$RUNNER_TEMP/sync-diff-report.json"), "sync must write the report to $RUNNER_TEMP")
  assert.ok(jobs.refresh.includes("SYNC_REPORT_FILE"), "manifest generation must read the report via SYNC_REPORT_FILE")
  assert.ok(jobs.refresh.includes("runner.temp"), "the report path must resolve via the runner.temp expression")
  assert.ok(
    !/^\s*sync-diff-report\.json\s*$/m.test(jobs.refresh),
    "sync-diff-report.json must never appear as a bare repo-root path",
  )
})

test("artifacts never carry secrets, tokens or forbidden data", () => {
  const forbidden = [
    ".env",
    "node_modules/",
    "data/predictions/",
    "data/model/",
    "data/history/",
    "data/synced/",
    "sync-football-data.ts",
  ]
  for (const path of forbidden) {
    assert.ok(!jobs.refresh.includes(path), `artifacts must never carry ${path}`)
  }
})

// --- commit allowlist --------------------------------------------------------

test("commit job stages only the allowlisted data files and never `git add .`", () => {
  assert.ok(!/^[ \t]*git add \.[ \t]*$/m.test(jobs.commit), "commit must never use `git add .` as a command")
  assert.ok(jobs.commit.includes("data/football/fixtures.json"))
  assert.ok(jobs.commit.includes("data/football/manifest.json"))
  assert.ok(jobs.commit.includes("data/evaluations/premier-league/2026-27/current-evaluation.json"))
  assert.ok(jobs.commit.includes("data/evaluations/premier-league/2026-27/evaluation-manifest.json"))
  for (const path of ["data/predictions/", "data/model/", "data/history/", "data/synced/"]) {
    assert.ok(!jobs.commit.includes(path), `commit must never stage ${path}`)
  }
})

test("commit uses the pinned message", () => {
  assert.ok(yml.includes("chore(data): refresh Premier League results"), "commit message must be pinned")
})

test("commit re-runs key data validation before committing", () => {
  assert.ok(jobs.commit.includes("npm run football:pl:verify"), "commit must re-run football:pl:verify")
  assert.ok(jobs.commit.includes("npm run verify:static-football"), "commit must re-run verify:static-football")
})

// --- condition matrix --------------------------------------------------------

test("schedule runs are skipped unless AUTO_REFRESH_ENABLED is true", () => {
  assert.ok(
    jobs.refresh.includes("github.event_name == 'workflow_dispatch' || vars.AUTO_REFRESH_ENABLED == 'true'"),
    "refresh if must gate schedule runs on vars.AUTO_REFRESH_ENABLED",
  )
})

test("commit gated on apply + data change; deploy gated on apply + change + commit + deploy flag + project", () => {
  assert.ok(
    jobs.commit.includes("needs.refresh.outputs.apply == 'true'") &&
      jobs.commit.includes("needs.refresh.outputs.data_changed == 'true'"),
    "commit if must require apply and data change",
  )
  assert.ok(
    jobs.deploy.includes("vars.AUTO_DEPLOY_ENABLED == 'true'") &&
      jobs.deploy.includes("vars.CLOUDFLARE_PAGES_PROJECT != ''") &&
      jobs.deploy.includes("needs.commit.result == 'success'"),
    "deploy if must require the deploy flag, the project variable and a successful commit",
  )
})

test("fetch-depth: 0 is used so source-commit verification can resolve", () => {
  const matches = yml.match(/fetch-depth: 0/g) ?? []
  assert.ok(matches.length >= 3, "all three jobs must fetch full history")
})

test("deploy verifies the artifact and does not rebuild a stale out/", () => {
  assert.ok(jobs.deploy.includes("--static-export"), "deploy must verify the downloaded static export")
  assert.ok(jobs.deploy.includes("artifacts/static-export/out"), "deploy must publish the downloaded out/, not a rebuild")
  assert.ok(!jobs.deploy.includes("npm run build"), "deploy must not rebuild out/ from its checkout")
})
