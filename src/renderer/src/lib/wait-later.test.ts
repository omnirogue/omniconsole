import { describe, expect, it } from 'vitest'
import {
  describeReturn,
  isReturnedPane,
  returnedMarks,
  setReturned,
  emptyWaitLater,
  finishedMarks,
  hoursUntil,
  isFinishedPane,
  isWaitingUntil,
  parseWaitLater,
  pruneWaitLater,
  setFinished,
  setWaitLater,
  WAIT_HOURS,
  waitLaterHours,
  waitLaterKeyForCard,
  waitLaterKeyForChain,
  waitLaterKeyForMessage,
  waitLaterKeyForPane,
  waitLaterKeyForThread,
  waitingKeys
} from './wait-later'

describe('wait-later', () => {
  const now = new Date('2026-09-11T14:00:00')

  it('offers a fast dial of hours and says when the work comes back', () => {
    expect(WAIT_HOURS).toEqual([1, 2, 4, 8, 12, 24, 36, 48])
    const until = waitLaterHours(12, now)
    expect(until).toEqual(new Date('2026-09-12T02:00:00'))
    expect(hoursUntil(until, now)).toBe(12)
    expect(hoursUntil(new Date(now.getTime() + 90 * 60_000), now)).toBe(2)
    // Why: same day shows only the time; another day names the day too.
    expect(describeReturn(waitLaterHours(2, now), now)).toMatch(/4:00/)
    expect(describeReturn(until, now)).toMatch(/Sep 12/)
  })

  it('keys wait until their time, then come back on their own', () => {
    const view = setWaitLater(
      setWaitLater(emptyWaitLater(), 'pane:a', new Date('2026-09-11T18:00:00')),
      'thread:b',
      new Date('2026-09-11T13:00:00')
    )
    expect(waitingKeys(view, now)).toEqual(new Set(['pane:a']))
    expect(isWaitingUntil(view.until['thread:b'], now)).toBe(false)
    expect(Object.keys(pruneWaitLater(view, now).until)).toEqual(['pane:a'])
    expect(setWaitLater(view, 'pane:a', null).until['pane:a']).toBeUndefined()
  })

  it('reads only its own shape and falls back to empty', () => {
    expect(parseWaitLater({ version: 1, until: { 'pane:a': 'x' } }).until['pane:a']).toBe('x')
    expect(parseWaitLater({ version: 2 })).toEqual(emptyWaitLater())
    expect(parseWaitLater('junk')).toEqual(emptyWaitLater())
  })

  it('a finished pane stays out until it asks again after the mark; old marks are pruned', () => {
    const marked = new Date('2026-09-11T14:00:00')
    const view = setFinished(emptyWaitLater(), 'pane:a', marked)
    const marks = finishedMarks(view)
    expect(isFinishedPane(marks, 'pane:a', marked.getTime() - 1)).toBe(true)
    expect(isFinishedPane(marks, 'pane:a', marked.getTime() + 60_000)).toBe(false)
    expect(isFinishedPane(marks, 'pane:b', marked.getTime() - 1)).toBe(false)
    expect(isFinishedPane(marks, 'pane:a', 0)).toBe(false)
    expect(Object.keys(pruneWaitLater(view, new Date('2026-10-20T14:00:00')).done)).toEqual([])
    expect(Object.keys(pruneWaitLater(view, new Date('2026-09-20T14:00:00')).done)).toEqual([
      'pane:a'
    ])
    expect(setFinished(view, 'pane:a', null).done['pane:a']).toBeUndefined()
    expect(parseWaitLater({ version: 1, until: {} }).done).toEqual({})
  })

  it('a returned pane needs the person until the row is opened; old marks are pruned', () => {
    const at = new Date('2026-09-11T14:00:00')
    const view = setReturned(emptyWaitLater(), 'pane:a', at)
    const marks = returnedMarks(view)
    expect(isReturnedPane(marks, 'pane:a', at.getTime() - 60_000)).toBe(true)
    // Why: work that started again after the plan ended is live work, not a waiting result.
    expect(isReturnedPane(marks, 'pane:a', at.getTime() + 60_000)).toBe(false)
    expect(isReturnedPane(marks, 'pane:b', 0)).toBe(false)
    expect(setReturned(view, 'pane:a', null).returned['pane:a']).toBeUndefined()
    expect(Object.keys(pruneWaitLater(view, new Date('2026-10-20T14:00:00')).returned)).toEqual([])
    expect(parseWaitLater({ version: 1, until: {} }).returned).toEqual({})
  })
})

describe('wait-later keys', () => {
  it('keys a peer message apart from cards, threads, panes and chains', () => {
    expect(waitLaterKeyForMessage('msg_1')).toBe('message:msg_1')
    expect(
      new Set([
        waitLaterKeyForMessage('x'),
        waitLaterKeyForCard('x'),
        waitLaterKeyForThread('x'),
        waitLaterKeyForPane('x'),
        waitLaterKeyForChain('x')
      ]).size
    ).toBe(5)
  })
})
