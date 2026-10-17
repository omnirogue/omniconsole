import { translate } from '@/i18n/i18n'

/**
 * How an advertising figure is written. One rule governs every function here:
 * a measure nobody reported prints an em dash, never 0 and never 0.00. A zero
 * cost would read as a free conversion and a zero spend as a quiet day.
 */

/** The word for a figure the source did not report. */
export const UNKNOWN = '—'

export function money(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNKNOWN
  }
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2
    }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency}`
  }
}

/** A signed figure, so a loss reads as one at a glance. */
export function signedMoney(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNKNOWN
  }
  const text = money(Math.abs(value), currency)
  return value < 0 ? `−${text}` : value > 0 ? `+${text}` : text
}

export function count(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? UNKNOWN
    : value.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

export function ratio(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? UNKNOWN
    : `${value.toFixed(2)}×`
}

export function percent(value: number | null | undefined, scale: 1 | 100 = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNKNOWN
  }
  return new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(
    scale === 100 ? value / 100 : value
  )
}

/** Tone for a profit figure. An unknown or zero figure is never coloured. */
export function profitTone(value: number | null): string {
  if (value === null || value === 0) {
    return ''
  }
  return value > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
}

/**
 * A provider timestamp as a reader can check it. A value with no timezone is
 * shown as sent and labelled, rather than silently rendered in local time as if
 * it had been verified.
 */
export function stamp(value: string | null | undefined, timezone = 'America/New_York'): string {
  if (!value) {
    return translate('advertising.notReported', 'Not reported')
  }
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    return translate('advertising.timeUnverified', '{{value}} (timezone unverified)', { value })
  }
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(new Date(value))
  } catch {
    return value
  }
}

export function ageLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return translate('advertising.ageUnknown', 'age unknown')
  }
  const minutes = Math.round(seconds / 60)
  if (minutes < 1) {
    return translate('advertising.ageUnderMinute', 'under a minute old')
  }
  if (minutes < 60) {
    return translate('advertising.ageMinutes', '{{count}} min old', { count: minutes })
  }
  const hours = Math.round(minutes / 60)
  return hours < 48
    ? translate('advertising.ageHours', '{{count}} h old', { count: hours })
    : translate('advertising.ageDays', '{{count}} days old', { count: Math.round(hours / 24) })
}

export function rangeLabel(rangeDays: 1 | 7 | 30): string {
  return rangeDays === 1
    ? translate('advertising.today', 'Today')
    : translate('advertising.lastDays', 'Last {{count}} days', { count: rangeDays })
}
