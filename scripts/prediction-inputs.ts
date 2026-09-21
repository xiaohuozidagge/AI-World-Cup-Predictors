/**
 * Shared input loading + fixture mapping for the 2026/27 prediction pipeline
 * (`generate-` and `verify-premier-league-predictions-2026-27.ts`). Reads the
 * committed v1 config and the static football snapshot, maps fixtures into the
 * model's `ModelMatch` shape, and computes the input/generator hashes. No
 * network I/O, no clock, no randomness — everything is a pure function of the
 * committed data and the explicit time arguments.
 */

import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { HISTORY_SEASONS } from "../lib/football/history-seasons"
import { hashConfig, resolveConfig, type DeepPartial, type ModelConfig } from "../lib/model/config"
import { sha256Hex, type ArtifactMatchMeta } from "../lib/model/prediction-artifact"
import type { ModelMatch } from "../lib/model/types"

export const COMPETITION_SLUG = "premier-league"
export const SEASON = "2026-27"
export const MODEL_VERSION = "1.0.0"
export const REASON_SOURCE = "v1"
/** The frozen v1 config hash (asserted against the on-disk config, never trusted). */
export const V1_CONFIG_HASH = "28b50575b3ceea4dcad6d6d3e581f2895d825c84b82745def1214f9678679680"

export const FOOTBALL_DIR = join(process.cwd(), "data", "football")
export const OUTPUT_DIR = join(process.cwd(), "data", "predictions", "premier-league", "2026-27")

/** Code files whose byte content defines the generation behaviour (hashed). */
export const GENERATOR_SOURCE_FILES = [
  join(process.cwd(), "scripts", "prediction-inputs.ts"),
  join(process.cwd(), "scripts", "generate-premier-league-predictions-2026-27.ts"),
  join(process.cwd(), "lib", "model", "prediction-artifact.ts"),
]

/* --------------------------- raw snapshot shapes --------------------------- */

export interface RawCompetition { id: string; slug: string; name: string; season: number | null }
export interface RawTeam { id: string; provider_team_id: number; name: string; short_name: string | null; slug: string }
export interface RawFixture {
  id: string
  provider_fixture_id: number
  competition_id: string
  season: number
  matchweek: number | null
  home_team_id: string
  away_team_id: string
  kickoff_at: string
  status: string
  fulltime_home_score: number | null
  fulltime_away_score: number | null
}
export interface RawManifest { provider: string; exportedAt: string; sourceLastUpdatedAt: string }

/* --------------------------- helpers --------------------------- */

export function fail(msg: string): never {
  throw new Error(`predictions:pl FAILED — ${msg}`)
}
export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg)
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T
}

/** Normalize a UTC ISO-8601 timestamp ("+00:00" → "Z") and validate the shape. */
export function normalizeUtc(iso: string): string {
  const trimmed = iso.trim()
  const z = trimmed.endsWith("+00:00") ? trimmed.slice(0, -6) + "Z" : trimmed
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(z), `not an ISO-8601 UTC timestamp: "${iso}"`)
  return z
}

export function currentCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim()
  } catch {
    return ""
  }
}

/* --------------------------- loading --------------------------- */

export function loadV1Config(): ModelConfig {
  const raw = readJson<DeepPartial<ModelConfig>>(join(process.cwd(), "data", "model", "premier-league", "v1", "config.json"))
  const config = resolveConfig(raw)
  assert(config.version === MODEL_VERSION, `v1 config version must be ${MODEL_VERSION}, got ${config.version}`)
  assert(config.calibration === undefined, "v1 config must not carry a calibration block (v1.1 not allowed)")
  assert(config.drawModel === undefined, "v1 config must not carry a drawModel (v1.2 not allowed)")
  assert(hashConfig(config) === V1_CONFIG_HASH, `v1 config hash changed: ${hashConfig(config)}`)
  return config
}

export interface Snapshot {
  competitionId: string
  teamsById: Map<string, RawTeam>
  fixtures: RawFixture[]
  manifest: RawManifest
}

export function loadSnapshot(): Snapshot {
  const competitions = readJson<RawCompetition[]>(join(FOOTBALL_DIR, "competitions.json"))
  const teams = readJson<RawTeam[]>(join(FOOTBALL_DIR, "teams.json"))
  const fixtures = readJson<RawFixture[]>(join(FOOTBALL_DIR, "fixtures.json"))
  const manifest = readJson<RawManifest>(join(FOOTBALL_DIR, "manifest.json"))

  const pl = competitions.find((c) => c.slug === COMPETITION_SLUG)
  assert(pl, "premier-league competition missing from snapshot")
  const teamsById = new Map(teams.map((t) => [t.id, t]))
  return { competitionId: pl.id, teamsById, fixtures, manifest }
}

/* --------------------------- mapping --------------------------- */

export interface MappedFixture {
  match: ModelMatch
  meta: ArtifactMatchMeta
}

export function fixtureToMapped(
  f: RawFixture,
  teamsById: Map<string, RawTeam>,
  competitionId: string,
  generatedAt: string,
  dataCutoff: string,
  configHash: string,
): MappedFixture {
  assert(f.competition_id === competitionId, `fixture ${f.id} not premier-league`)
  const home = teamsById.get(f.home_team_id)
  const away = teamsById.get(f.away_team_id)
  assert(home && away, `fixture ${f.id} references an unknown team`)
  assert(home.slug !== away.slug, `fixture ${f.id} has home == away`)

  const hasResult = f.fulltime_home_score !== null && f.fulltime_away_score !== null
  assert(hasResult === (f.status === "FINISHED"), `fixture ${f.id}: status/score inconsistency`)

  const id = `pl-2026-27-${home.slug}-vs-${away.slug}-${f.provider_fixture_id}`
  const slug = `${home.slug}-vs-${away.slug}-${f.provider_fixture_id}`
  const kickoffUtc = normalizeUtc(f.kickoff_at)
  const date = kickoffUtc.slice(0, 10)

  const match: ModelMatch = {
    id,
    season: SEASON,
    date,
    homeSlug: home.slug,
    awaySlug: away.slug,
    homeGoals: hasResult ? (f.fulltime_home_score as number) : 0,
    awayGoals: hasResult ? (f.fulltime_away_score as number) : 0,
  }

  const meta: ArtifactMatchMeta = {
    id,
    slug,
    competitionSlug: COMPETITION_SLUG,
    season: SEASON,
    matchweek: f.matchweek,
    kickoffUtc,
    homeTeam: { slug: home.slug, name: home.name, shortName: home.short_name },
    awayTeam: { slug: away.slug, name: away.name, shortName: away.short_name },
    predictionType: hasResult ? "backtest" : "candidate",
    predictionState: hasResult ? "historical_reconstruction" : "unlocked",
    actualScore: hasResult ? { home: f.fulltime_home_score as number, away: f.fulltime_away_score as number } : null,
    modelVersion: MODEL_VERSION,
    configHash,
    generatedAt,
    dataCutoff,
    reasonSource: REASON_SOURCE,
  }

  return { match, meta }
}

/* --------------------------- hashing --------------------------- */

export function computeInputDataHash(): string {
  const parts: Buffer[] = []
  for (const spec of HISTORY_SEASONS) {
    parts.push(readFileSync(join(process.cwd(), "data", "history", "premier-league", "normalized", `${spec.season}.json`)))
  }
  for (const name of ["competitions.json", "teams.json", "fixtures.json", "manifest.json"]) {
    parts.push(readFileSync(join(FOOTBALL_DIR, name)))
  }
  return sha256Hex(...parts)
}

export function computeGeneratorHash(): string {
  return sha256Hex(...GENERATOR_SOURCE_FILES.map((f) => readFileSync(f)))
}
