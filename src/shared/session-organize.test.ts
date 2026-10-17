import { describe, expect, it } from 'vitest'
import type { SessionManageState } from './session-manage-types'
import { parseSnoozeUntil } from './session-organize'
import {
  estimateSessionFocusLines,
  sessionFocusGroup,
  type SessionFocusRow
} from './session-organize-focus'

const NOW = new Date(2026, 8, 25, 14, 30, 0)

describe('parseSnoozeUntil', () => {
  it('reads relative, day-and-time and ISO wake times in local time', () => {
    expect(parseSnoozeUntil('+2h', NOW)).toBe(NOW.getTime() + 2 * 3_600_000)
    expect(parseSnoozeUntil('30m', NOW)).toBe(NOW.getTime() + 30 * 60_000)
    expect(parseSnoozeUntil('+1d', NOW)).toBe(NOW.getTime() + 86_400_000)
    expect(parseSnoozeUntil('tomorrow 9:00', NOW)).toBe(new Date(2026, 8, 26, 9, 0).getTime())
    expect(parseSnoozeUntil('tomorrow', NOW)).toBe(new Date(2026, 8, 26, 9, 0).getTime())
    expect(parseSnoozeUntil('today 5pm', NOW)).toBe(new Date(2026, 8, 25, 17, 0).getTime())
    expect(parseSnoozeUntil('2026-09-30T08:00:00Z', NOW)).toBe(Date.UTC(2026, 8, 30, 8))
  })

  it('wakes with none and refuses a past or unreadable time', () => {
    expect(parseSnoozeUntil('none', NOW)).toBeNull()
    expect(() => parseSnoozeUntil('today 9:00', NOW)).toThrow(/already past/)
    expect(() => parseSnoozeUntil('next blue moon', NOW)).toThrow(/not a wake time/)
    expect(() => parseSnoozeUntil('tomorrow 25:00', NOW)).toThrow(/not a time of day/)
  })
})

function sessions(count: number, folders: number, states: SessionManageState[]): SessionFocusRow[] {
  return Array.from({ length: count }, (_, index) => ({
    folder: `Company ${index % folders} / Project ${index % 7}`,
    archived: false,
    hidden: false,
    snoozed: false,
    state: states[index % states.length]!
  }))
}

describe('estimateSessionFocusLines', () => {
  it('keeps 30 and 100 busy sessions within five lines, with Needs you as one line', () => {
    for (const count of [30, 100]) {
      const focus = estimateSessionFocusLines(
        sessions(count, 9, ['working', 'awaiting-user', 'idle', 'queued', 'provider-limited'])
      )
      expect(focus.lines).toBeLessThanOrEqual(5)
      expect(focus.needsYou).toBe(count / 5)
      expect(focus.folders).toHaveLength(3)
      expect(focus.folded.length).toBeGreaterThan(0)
      expect(focus.everythingElse.sessions).toBeGreaterThan(0)
    }
  })

  it('collapses a quiet day to Everything else, and hidden, snoozed or archived rows get no line', () => {
    const quiet = sessions(30, 4, ['idle', 'exited'])
    expect(estimateSessionFocusLines(quiet)).toMatchObject({
      lines: 1,
      needsYou: 0,
      folders: [],
      everythingElse: { sessions: 30, folders: 4 }
    })
    const putAway = sessions(10, 2, ['working']).map((row, index) => ({
      ...row,
      hidden: index % 3 === 0,
      snoozed: index % 3 === 1,
      archived: index % 3 === 2
    }))
    // Why one: Everything else is always drawn, as the focus view draws it.
    expect(estimateSessionFocusLines(putAway)).toMatchObject({
      lines: 1,
      everythingElse: { sessions: 0, folders: 0 }
    })
  })

  it('still counts a hidden question in Needs you', () => {
    const focus = estimateSessionFocusLines([
      { folder: null, archived: false, hidden: true, snoozed: false, state: 'awaiting-user' }
    ])
    // Why two: Needs you and Everything else; the question never earns its folder a line too.
    expect(focus).toMatchObject({ needsYou: 1, lines: 2, folders: [] })
  })

  it('groups by company, and by project under Saved Sessions', () => {
    expect(sessionFocusGroup('OmniRogue / Checkout / Fixes')).toBe('OmniRogue')
    expect(sessionFocusGroup('Saved Sessions / Q3 / Ads')).toBe('Saved Sessions / Q3')
    expect(sessionFocusGroup(null)).toBe('Unfiled')
  })
})
