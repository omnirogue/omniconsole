import { afterEach, describe, expect, it } from 'vitest'
import {
  sessionWaitersOf,
  setSessionWaitersSource,
  UNREADABLE_WAITERS
} from './steward-waiter-source'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()!()
  }
})

describe('who waits on a session', () => {
  it('reads nothing as awaited until WP-S3 registers its waits', () => {
    expect(sessionWaitersOf(['tab-1:leaf-1', 'view-1'])).toEqual([])
  })

  it('finds the waiters under any of the session’s keys, once each', () => {
    cleanups.push(
      setSessionWaitersSource(
        () =>
          new Map([
            ['tab-1:leaf-1', ['tab-9:leaf-1']],
            ['view-1', ['tab-9:leaf-1', 'tab-8:leaf-1']]
          ])
      )
    )
    expect(sessionWaitersOf(['tab-1:leaf-1', 'view-1', null])).toEqual([
      'tab-9:leaf-1',
      'tab-8:leaf-1'
    ])
    expect(sessionWaitersOf(['tab-2:leaf-1'])).toEqual([])
  })

  it('reads an index it cannot read as awaited', () => {
    cleanups.push(
      setSessionWaitersSource(() => {
        throw new Error('corrupt')
      })
    )
    expect(sessionWaitersOf(['tab-1:leaf-1'])).toEqual([UNREADABLE_WAITERS])
  })
})
