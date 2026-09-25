import { FootballDataError, isRetryable, type FootballDataErrorKind } from "./errors"
import type {
  Competition,
  CompetitionMatchesResponse,
  CompetitionTeamsResponse,
  Match,
  StandingsResponse,
  Team,
} from "./types"

/**
 * Server-only client for football-data.org v4.
 *
 * - Native `fetch` (no axios / node http) so it stays runtime-agnostic.
 * - Reads FOOTBALL_DATA_API_KEY from `process.env` at request time — the key is
 *   NEVER logged, NEVER placed in a User-Agent or any header other than
 *   `X-Auth-Token`, and NEVER bundled into the client.
 * - Free tier is ~10 requests/minute, so every request (including retries) is
 *   throttled to a conservative minimum interval.
 * - Retries at most 2 times, and only for rate-limit / server / network /
 *   timeout errors. Auth (401/403) and not-found (404) fail fast.
 */

const BASE_URL = "https://api.football-data.org/v4"
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_RETRIES = 2
const MIN_REQUEST_INTERVAL_MS = 6_500

export type CompetitionCode = "PL" | "CL"

// --- module state -----------------------------------------------------------

let lastRequestAt = 0
let throttleChain: Promise<void> = Promise.resolve()
const inFlight = new Map<string, Promise<unknown>>()

// --- helpers ----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getApiKey(): string {
  const key = process.env.FOOTBALL_DATA_API_KEY
  if (!key) {
    throw new FootballDataError(
      "football-data.org is not configured. Set FOOTBALL_DATA_API_KEY (server only).",
      { kind: "auth" },
    )
  }
  return key
}

/**
 * Wait until the next request is permitted by the free-tier rate limit.
 *
 * Serialized through a promise chain so concurrent callers cannot slip two
 * requests through the same interval window.
 */
function throttle(): Promise<void> {
  const next = throttleChain.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now()
    if (wait > 0) {
      await sleep(wait)
    }
    lastRequestAt = Date.now()
  })
  throttleChain = next.catch(() => {})
  return next
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null
}

function backoffMs(attempt: number): number {
  return 1_000 * 2 ** attempt
}

function classify(status: number): FootballDataErrorKind {
  if (status === 401 || status === 403) return "auth"
  if (status === 404) return "not_found"
  if (status === 429) return "rate_limit"
  if (status >= 500) return "server"
  return "http"
}

// --- request -----------------------------------------------------------------

async function request<T>(path: string): Promise<T> {
  const key = getApiKey()
  const url = `${BASE_URL}${path}`

  // De-duplicate identical in-flight requests within a run: concurrent callers
  // share one fetch instead of hitting the same endpoint back-to-back.
  const existing = inFlight.get(url)
  if (existing) {
    return existing as Promise<T>
  }

  const promise = doRequest<T>(url, key)
  inFlight.set(url, promise)
  try {
    return await promise
  } finally {
    inFlight.delete(url)
  }
}

async function doRequest<T>(url: string, key: string): Promise<T> {
  let lastError: FootballDataError | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          "X-Auth-Token": key,
          "User-Agent": "ai-predictor/1.0",
        },
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      const kind: FootballDataErrorKind =
        err instanceof Error && err.name === "AbortError" ? "timeout" : "network"
      lastError = new FootballDataError(
        kind === "timeout" ? "football-data.org request timed out" : "football-data.org network error",
        { kind, cause: err },
      )
      if (!isRetryable(kind) || attempt === MAX_RETRIES) throw lastError
      continue
    }

    clearTimeout(timer)

    if (response.ok) {
      return (await response.json()) as T
    }

    const status = response.status
    const kind = classify(status)
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"))
    const error = new FootballDataError(
      `football-data.org responded ${status} ${response.statusText}`,
      { kind, status, retryAfterSeconds },
    )

    if (!isRetryable(kind) || attempt === MAX_RETRIES) throw error

    if (kind === "rate_limit" && retryAfterSeconds != null) {
      await sleep(Math.min(retryAfterSeconds * 1_000, 30_000))
    } else {
      await sleep(backoffMs(attempt))
    }
    lastError = error
  }

  // Unreachable: the loop above always throws or returns. Kept for the compiler.
  throw lastError ?? new FootballDataError("football-data.org request failed", { kind: "http" })
}

// --- public API --------------------------------------------------------------

export async function getCompetition(code: CompetitionCode): Promise<Competition> {
  return request<Competition>(`/competitions/${code}`)
}

export async function getCompetitionTeams(
  code: CompetitionCode,
  season: number,
): Promise<Team[]> {
  const res = await request<CompetitionTeamsResponse>(`/competitions/${code}/teams?season=${season}`)
  return res.teams ?? []
}

export async function getCompetitionMatches(
  code: CompetitionCode,
  season: number,
): Promise<Match[]> {
  const res = await request<CompetitionMatchesResponse>(`/competitions/${code}/matches?season=${season}`)
  return res.matches ?? []
}

export async function getCompetitionStandings(
  code: CompetitionCode,
  season: number,
): Promise<StandingsResponse> {
  return request<StandingsResponse>(`/competitions/${code}/standings?season=${season}`)
}
