/**
 * Canonical metadata for the five historical Premier League seasons imported
 * from football-data.co.uk. Shared by the download, import, verify, and
 * coverage scripts so the season set never drifts between them.
 */

export interface HistorySeasonSpec {
  /** Display season label, e.g. "2021-22". */
  season: string
  /** football-data.co.uk directory code, e.g. "2122". */
  code: string
  /** Full source URL for the Premier League (E0) CSV. */
  sourceUrl: string
  /** Raw CSV path relative to `data/history/premier-league/`. */
  rawFile: string
  /** Normalized JSON path relative to `data/history/premier-league/`. */
  normalizedFile: string
}

export const HISTORY_COMPETITION_SLUG = "premier-league"

export const HISTORY_SEASONS: readonly HistorySeasonSpec[] = [
  {
    season: "2021-22",
    code: "2122",
    sourceUrl: "https://football-data.co.uk/mmz4281/2122/E0.csv",
    rawFile: "raw/2021-22.csv",
    normalizedFile: "normalized/2021-22.json",
  },
  {
    season: "2022-23",
    code: "2223",
    sourceUrl: "https://football-data.co.uk/mmz4281/2223/E0.csv",
    rawFile: "raw/2022-23.csv",
    normalizedFile: "normalized/2022-23.json",
  },
  {
    season: "2023-24",
    code: "2324",
    sourceUrl: "https://football-data.co.uk/mmz4281/2324/E0.csv",
    rawFile: "raw/2023-24.csv",
    normalizedFile: "normalized/2023-24.json",
  },
  {
    season: "2024-25",
    code: "2425",
    sourceUrl: "https://football-data.co.uk/mmz4281/2425/E0.csv",
    rawFile: "raw/2024-25.csv",
    normalizedFile: "normalized/2024-25.json",
  },
  {
    season: "2025-26",
    code: "2526",
    sourceUrl: "https://football-data.co.uk/mmz4281/2526/E0.csv",
    rawFile: "raw/2025-26.csv",
    normalizedFile: "normalized/2025-26.json",
  },
]
