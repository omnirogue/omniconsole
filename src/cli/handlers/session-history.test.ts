import { describe, expect, it } from 'vitest'
import { parseActionsFlags } from './session-history'

const flags = (entries: Record<string, string>) =>
  new Map<string, string | boolean>(Object.entries(entries))

describe('parseActionsFlags', () => {
  const now = Date.UTC(2026, 8, 25, 12, 0, 0)

  it('reads --since as a window back from now, with actor and kind lists', () => {
    expect(
      parseActionsFlags(
        flags({ since: '2h', actor: 'pane,cli', kind: 'move,title', limit: '20' }),
        now
      )
    ).toEqual({
      since: now - 2 * 3_600_000,
      actors: ['pane', 'cli'],
      kinds: ['move', 'title'],
      limit: 20
    })
    expect(parseActionsFlags(flags({}), now)).toEqual({ since: now - 24 * 3_600_000 })
  })

  it('refuses an unreadable duration or an unknown actor before calling anything', () => {
    expect(() => parseActionsFlags(flags({ since: 'yesterday' }), now)).toThrow('--since')
    expect(() => parseActionsFlags(flags({ actor: 'robot' }), now)).toThrow('Unknown --actor robot')
  })

  it('filters on the session steward since Phase 2 made it an actor', () => {
    expect(parseActionsFlags(flags({ actor: 'steward' }), now).actors).toEqual(['steward'])
  })
})
