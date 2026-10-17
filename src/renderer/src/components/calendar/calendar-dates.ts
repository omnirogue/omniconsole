export type CalendarView = 'month' | 'week' | 'day'

export function dayKey(value: string | Date): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value
  }
  const date = value instanceof Date ? value : new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function dayDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}

// Noon-anchored calendar arithmetic preserves days across DST transitions.
export function shiftDay(value: string, days: number): string {
  const date = dayDate(value)
  date.setDate(date.getDate() + days)
  return dayKey(date)
}

export function shiftMonth(value: string, months: number): string {
  const date = dayDate(value)
  const last = new Date(date.getFullYear(), date.getMonth() + months + 1, 0, 12).getDate()
  return dayKey(
    new Date(date.getFullYear(), date.getMonth() + months, Math.min(date.getDate(), last), 12)
  )
}

export function calendarDays(anchor: string, view: CalendarView): string[] {
  if (view === 'day') {
    return [anchor]
  }
  const first = view === 'month' ? `${anchor.slice(0, 7)}-01` : anchor
  const start = shiftDay(first, -dayDate(first).getDay())
  return Array.from({ length: view === 'month' ? 42 : 7 }, (_, index) => shiftDay(start, index))
}

export function localDateTime(value: string): string {
  if (!value) {
    return ''
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T09:00`
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return ''
  }
  return `${dayKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function entryOnDay(
  entry: { starts_at: string; ends_at?: string | null },
  day: string
): boolean {
  const starts = dayKey(entry.starts_at)
  // End instants are exclusive, so a meeting ending at midnight stays on the prior day.
  const ends =
    entry.ends_at && Date.parse(entry.ends_at) > Date.parse(entry.starts_at)
      ? dayKey(new Date(Date.parse(entry.ends_at) - 1))
      : starts
  return day >= starts && day <= ends
}

export function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}
