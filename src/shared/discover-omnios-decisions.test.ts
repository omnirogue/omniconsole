import { describe, expect, it } from 'vitest'
import { discoverActedOnKeys, parseDiscoverDecisions } from './discover-omnios-decisions'

describe('Discover page decisions', () => {
  it('keeps well-formed rows and leaves out malformed ones', () => {
    const decisions = parseDiscoverDecisions({
      version: 1,
      decisions: [
        {
          n: 1,
          key: 'find.r1.1',
          title: 'A',
          pick: 'start',
          at: '2026-10-15T10:00:00.000Z',
          receipt: { operationId: 'op', terminal: 'term', extra: 'dropped' }
        },
        { n: 2, key: 'find.r1.2', title: 'B', pick: 'not-now', at: 'x' },
        { n: 3, key: 'find.r1.3', pick: 'maybe' },
        { n: '4', key: 'find.r1.4', pick: 'dig' },
        null
      ]
    })
    expect(decisions).toEqual([
      {
        n: 1,
        key: 'find.r1.1',
        title: 'A',
        pick: 'start',
        at: '2026-10-15T10:00:00.000Z',
        receipt: { operationId: 'op', terminal: 'term' }
      },
      { n: 2, key: 'find.r1.2', title: 'B', pick: 'not-now', at: 'x' }
    ])
    expect(parseDiscoverDecisions(null)).toEqual([])
    expect(parseDiscoverDecisions({ decisions: 'no' })).toEqual([])
  })

  it('counts Start and Dig deeper as acted on, never Not now', () => {
    const row = (n: number, pick: 'start' | 'dig' | 'not-now') => ({
      n,
      key: `find.r1.${n}`,
      title: '',
      pick,
      at: ''
    })
    expect(discoverActedOnKeys([row(1, 'start'), row(2, 'dig'), row(3, 'not-now')])).toEqual(
      new Set(['find.r1.1', 'find.r1.2'])
    )
  })
})
