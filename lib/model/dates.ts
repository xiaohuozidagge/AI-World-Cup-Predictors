/**
 * Pure calendar arithmetic for the model. Converts a "YYYY-MM-DD" date into an
 * integer day index (days since 2020-01-01) so time decay can be computed with
 * no runtime clock and no `Date`. Deterministic.
 */

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** Convert "YYYY-MM-DD" to an integer day index relative to 2020-01-01. */
export function dateToDayIndex(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new Error(`invalid date for day index: "${date}"`)
  return daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]))
}
