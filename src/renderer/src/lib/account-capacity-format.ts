import { translate } from '@/i18n/i18n'
import type {
  AccountCapacityRow,
  AccountCapacityState,
  CapacityWindow
} from '../../../shared/provider-account-capacity'

const READING_TIME_STALE_MS = 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/** "8:20 PM" within the next day, otherwise "Sat 11:59 PM". */
export function formatCapacityResetTime(resetsAt: number, now = Date.now()): string {
  const date = new Date(resetsAt)
  return resetsAt - now < DAY_MS
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

export type CapacityWindowKind = 'fiveHour' | 'weekly' | 'fableWeekly'

function windowName(kind: CapacityWindowKind): string {
  switch (kind) {
    case 'fiveHour':
      return translate('accountCapacity.fiveHourLimit', '5-hour limit')
    case 'weekly':
      return translate('accountCapacity.weeklyLimit', 'Weekly limit')
    case 'fableWeekly':
      return translate('accountCapacity.fableWeeklyLimit', 'Fable weekly')
  }
}

/** "5-hour limit: 82% left · resets 8:20 PM" */
export function formatCapacityWindowLine(
  kind: CapacityWindowKind,
  window: CapacityWindow,
  now = Date.now()
): string {
  const percent = Math.round(window.remainingPercent)
  return window.resetsAt === null
    ? translate('accountCapacity.windowLine', '{{name}}: {{percent}}% left', {
        name: windowName(kind),
        percent
      })
    : translate(
        'accountCapacity.windowLineReset',
        '{{name}}: {{percent}}% left · resets {{time}}',
        {
          name: windowName(kind),
          percent,
          time: formatCapacityResetTime(window.resetsAt, now)
        }
      )
}

/** Redeemable credits are separate from scheduled window resets. */
export function capacityResetCreditLine(row: AccountCapacityRow): string {
  const count = row.availableResetCredits
  if (row.provider !== 'codex' || count == null || !Number.isSafeInteger(count) || count < 0) {
    return translate('accountCapacity.resetsUnknown', 'Usage resets: not reported')
  }
  return translate('accountCapacity.resetsAvailable', 'Usage resets: {{count}} available', {
    count
  })
}

/** Every window the row reports, in display order. */
export function capacityWindowLines(row: AccountCapacityRow, now = Date.now()): string[] {
  const lines: string[] = []
  if (row.fiveHour) {
    lines.push(formatCapacityWindowLine('fiveHour', row.fiveHour, now))
  }
  if (row.weekly) {
    lines.push(formatCapacityWindowLine('weekly', row.weekly, now))
  }
  if (row.fableWeekly) {
    lines.push(formatCapacityWindowLine('fableWeekly', row.fableWeekly, now))
  }
  lines.push(capacityResetCreditLine(row))
  return lines
}

/** "3:04 PM", or "Thu 3:04 PM" once the reading is over a day old. */
export function formatCapacityReadingTime(readingAt: number, now = Date.now()): string {
  const reading = new Date(readingAt)
  const options = { hour: 'numeric', minute: '2-digit' } as const
  return now - readingAt >= READING_TIME_STALE_MS
    ? reading.toLocaleString(undefined, { weekday: 'short', ...options })
    : reading.toLocaleTimeString(undefined, options)
}

/**
 * The single status line for a capacity row, shared by the launcher and
 * Settings so both surfaces show identical text for the same row. A 'usable'
 * row may still carry windows from an older reading, so it names the age
 * ("last updated") instead of implying the row was just read.
 */
export function capacityStateLine(row: AccountCapacityRow, now = Date.now()): string | null {
  switch (row.state) {
    case 'ready':
      return null
    case 'limited':
      return row.limitedUntil === null
        ? translate('settings.accountBalances.rateLimited', 'Rate limited')
        : translate('accountCapacity.limitedUntil', 'Rate limited until {{time}}', {
            time: formatCapacityResetTime(row.limitedUntil, now)
          })
    case 'usable':
      if (row.readingPausedUntil !== null) {
        return translate(
          'settings.accountBalances.readingPaused',
          'Ready · usage reading paused until {{time}}',
          {
            time: formatCapacityResetTime(row.readingPausedUntil, now)
          }
        )
      }
      return row.readingAt === null
        ? translate('accountCapacity.usableNoReading', 'Ready · usage not read yet')
        : translate('accountCapacity.usableStaleReading', 'Ready · last updated {{time}}', {
            time: formatCapacityReadingTime(row.readingAt, now)
          })
    case 'checking':
      return translate('accountCapacity.checking', 'Checking usage…')
    case 'signed-out':
      return translate('accountCapacity.needsSignIn', 'Needs sign-in')
  }
}

/** One short line for a menu row: "82% 5h · 64% weekly", or the state when there is no reading. */
export function formatCapacityCompact(row: AccountCapacityRow, now = Date.now()): string {
  if (row.state === 'signed-out') {
    return translate('accountCapacity.needsSignIn', 'Needs sign-in')
  }
  if (row.state === 'limited' && row.limitedUntil !== null) {
    return [
      translate('accountCapacity.limitedUntil', 'Rate limited until {{time}}', {
        time: formatCapacityResetTime(row.limitedUntil, now)
      }),
      capacityResetCreditLine(row)
    ].join(' · ')
  }
  const parts: string[] = []
  if (row.fiveHour) {
    parts.push(
      translate('accountCapacity.compactFiveHour', '{{percent}}% 5h', {
        percent: Math.round(row.fiveHour.remainingPercent)
      })
    )
  }
  if (row.weekly) {
    parts.push(
      translate('accountCapacity.compactWeekly', '{{percent}}% weekly', {
        percent: Math.round(row.weekly.remainingPercent)
      })
    )
  }
  if (parts.length > 0) {
    return [...parts, capacityResetCreditLine(row)].join(' · ')
  }
  if (row.state === 'checking') {
    return translate('accountCapacity.checking', 'Checking usage…')
  }
  return [
    translate('accountCapacity.usableNoReading', 'Ready · usage not read yet'),
    capacityResetCreditLine(row)
  ].join(' · ')
}

const STATE_ORDER: Record<AccountCapacityState, number> = {
  ready: 0,
  usable: 1,
  checking: 2,
  limited: 3,
  'signed-out': 4
}

function tightestRemaining(row: AccountCapacityRow): number {
  const windows = [row.fiveHour, row.weekly].filter(
    (window): window is CapacityWindow => window !== null
  )
  return windows.length === 0 ? -1 : Math.min(...windows.map((window) => window.remainingPercent))
}

/** Default first, then launchable accounts with the most room, then limited, then signed out. */
export function sortCapacityRows(rows: readonly AccountCapacityRow[]): AccountCapacityRow[] {
  return [...rows].sort((a, b) => {
    if (a.isDefault !== b.isDefault) {
      return a.isDefault ? -1 : 1
    }
    const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state]
    if (byState !== 0) {
      return byState
    }
    const byRoom = tightestRemaining(b) - tightestRemaining(a)
    if (byRoom !== 0) {
      return byRoom
    }
    return (a.email ?? '').localeCompare(b.email ?? '')
  })
}
