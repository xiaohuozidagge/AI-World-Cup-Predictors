/**
 * A small RFC 4180-compatible CSV parser plus helpers for reading
 * football-data.co.uk `E0.csv` (Premier League) files. Pure — no I/O, no Date.
 */

/** Parse an RFC 4180 CSV string into a grid of strings. */
export function parseCsv(text: string): string[][] {
  // Strip a single leading UTF-8 BOM if present.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  let i = 0

  while (i < input.length) {
    const ch = input[i]

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"'
          i += 2
        } else {
          inQuotes = false
          i += 1
        }
      } else {
        field += ch
        i += 1
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
      i += 1
    } else if (ch === ",") {
      row.push(field)
      field = ""
      i += 1
    } else if (ch === "\r") {
      row.push(field)
      field = ""
      rows.push(row)
      row = []
      // Consume the \n of a CRLF pair when present.
      i += input[i + 1] === "\n" ? 2 : 1
    } else if (ch === "\n") {
      row.push(field)
      field = ""
      rows.push(row)
      row = []
      i += 1
    } else {
      field += ch
      i += 1
    }
  }

  // Flush the final field/row if the input did not end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

/** True when a parsed row carries no meaningful content (a trailing/blank line). */
export function isBlankRow(row: string[]): boolean {
  return row.length === 0 || row.every((cell) => cell.trim() === "")
}

/** The header columns an E0.csv file must contain for this import. */
export const REQUIRED_E0_HEADERS = ["Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG", "FTR"] as const

/** Column index map for the E0.csv header (case-sensitive). */
export interface E0HeaderMap {
  div: number | null
  date: number
  time: number | null
  homeTeam: number
  awayTeam: number
  fthg: number
  ftag: number
  ftr: number
  hthg: number | null
  htag: number | null
  htr: number | null
}

/** Build a column index map from a parsed header row; throws on a missing required column. */
export function buildE0HeaderMap(headers: string[]): E0HeaderMap {
  const required = ["Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG", "FTR"]
  const missing = required.filter((name) => headers.indexOf(name) < 0)
  if (missing.length > 0) {
    throw new Error(`E0.csv header missing required column(s): ${missing.join(", ")}`)
  }
  const optional = (name: string): number | null => {
    const idx = headers.indexOf(name)
    return idx < 0 ? null : idx
  }
  return {
    div: optional("Div"),
    date: headers.indexOf("Date"),
    time: optional("Time"),
    homeTeam: headers.indexOf("HomeTeam"),
    awayTeam: headers.indexOf("AwayTeam"),
    fthg: headers.indexOf("FTHG"),
    ftag: headers.indexOf("FTAG"),
    ftr: headers.indexOf("FTR"),
    hthg: optional("HTHG"),
    htag: optional("HTAG"),
    htr: optional("HTR"),
  }
}

/** A single extracted E0.csv data row, with fields still in their raw string form. */
export interface E0Row {
  div: string | null
  date: string
  time: string | null
  homeTeam: string
  awayTeam: string
  fthg: string
  ftag: string
  ftr: string
  hthg: string | null
  htag: string | null
  htr: string | null
}

/** Extract a data row into an `E0Row` using the header map. */
export function extractE0Row(cells: string[], map: E0HeaderMap): E0Row {
  const cell = (idx: number | null): string | null => (idx == null ? null : (cells[idx] ?? "").trim())
  return {
    div: cell(map.div),
    date: (cells[map.date] ?? "").trim(),
    time: cell(map.time),
    homeTeam: (cells[map.homeTeam] ?? "").trim(),
    awayTeam: (cells[map.awayTeam] ?? "").trim(),
    fthg: (cells[map.fthg] ?? "").trim(),
    ftag: (cells[map.ftag] ?? "").trim(),
    ftr: (cells[map.ftr] ?? "").trim(),
    hthg: cell(map.hthg),
    htag: cell(map.htag),
    htr: cell(map.htr),
  }
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** Parse a "DD/MM/YYYY" date string into "YYYY-MM-DD"; throws on a bad value. */
export function parseDmyDate(value: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim())
  if (!m) throw new Error(`invalid E0 date: "${value}"`)
  const day = Number(m[1])
  const month = Number(m[2])
  const year = Number(m[3])
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]
  if (month < 1 || month > 12 || day < 1 || day > maxDay) {
    throw new Error(`invalid E0 date: "${value}"`)
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/** Parse a "HH:MM" kickoff time, or return null for a blank value. */
export function parseLocalTime(value: string): string | null {
  const t = value.trim()
  if (t === "") return null
  if (!/^\d{1,2}:\d{2}$/.test(t)) throw new Error(`invalid E0 time: "${value}"`)
  return t
}
