export function sortMatchesByKickoff<T extends { date: string; utcDate?: string; matchNumber?: number }>(
  items: T[]
): T[] {
  return [...items].sort((a, b) => {
    const aTime = a.utcDate ? new Date(a.utcDate).getTime() : new Date(a.date + "T00:00:00Z").getTime()
    const bTime = b.utcDate ? new Date(b.utcDate).getTime() : new Date(b.date + "T00:00:00Z").getTime()
    if (!isNaN(aTime) && !isNaN(bTime)) return aTime - bTime
    if (!isNaN(aTime)) return -1
    if (!isNaN(bTime)) return 1
    return (a.matchNumber || 0) - (b.matchNumber || 0)
  })
}

export function findNextMatch<T extends { utcDate?: string; date: string }>(
  items: T[],
  now: number | string,
): T | undefined {
  const nowMs = typeof now === "number" ? now : new Date(now).getTime()
  const sorted = sortMatchesByKickoff(items)
  return sorted.find(m => {
    const t = m.utcDate ? new Date(m.utcDate).getTime() : new Date(m.date + "T23:59:59Z").getTime()
    return t > nowMs
  })
}

export function matchesForDate<T extends { date: string }>(items: T[], dateStr: string): T[] {
  return items.filter(m => m.date === dateStr)
}

export function uniqueMatchDates<T extends { date: string }>(items: T[]): string[] {
  return [...new Set(items.map(m => m.date))].sort()
}
