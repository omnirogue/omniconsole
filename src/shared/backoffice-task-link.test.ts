import { describe, expect, it } from 'vitest'

import {
  backofficeOpenTarget,
  parseBackofficeLink,
  parseBackofficeTaskId
} from './backoffice-task-link'

describe('parseBackofficeTaskId', () => {
  it('accepts omni:// and orca:// task links', () => {
    expect(parseBackofficeTaskId('omni://backoffice/task/btk_abc123')).toBe('btk_abc123')
    expect(parseBackofficeTaskId('orca://backoffice/task/btk_abc123')).toBe('btk_abc123')
  })

  it('rejects other protocols, hosts, and shapes', () => {
    expect(parseBackofficeTaskId('https://backoffice/task/btk_abc123')).toBeNull()
    expect(parseBackofficeTaskId('omni://skills/task/btk_abc123')).toBeNull()
    expect(parseBackofficeTaskId('omni://backoffice/btk_abc123')).toBeNull()
    expect(parseBackofficeTaskId('omni://backoffice/task/btk_abc123/extra')).toBeNull()
    expect(parseBackofficeTaskId('not a url')).toBeNull()
  })

  it('rejects ids that are not btk_ slugs (injection surface)', () => {
    expect(parseBackofficeTaskId('omni://backoffice/task/rm-rf')).toBeNull()
    // Why: case is part of the id the hub mints; only the length and alphabet are bounded.
    expect(parseBackofficeTaskId('omni://backoffice/task/btk_AbC123')).toBe('btk_AbC123')
    expect(parseBackofficeTaskId('omni://backoffice/task/btk_ab-cd')).toBeNull()
    expect(parseBackofficeTaskId('omni://backoffice/task/btk_a')).toBeNull()
    expect(parseBackofficeTaskId(`omni://backoffice/task/btk_${'a'.repeat(65)}`)).toBeNull()
    expect(parseBackofficeTaskId('omni://backoffice/task/btk_abc%20def')).toBeNull()
  })

  it('is not satisfied by a thread link', () => {
    expect(parseBackofficeTaskId('omni://backoffice/thread/hth_abc123')).toBeNull()
  })
})

describe('parseBackofficeLink', () => {
  it('names a card or a handoff thread', () => {
    expect(parseBackofficeLink('omni://backoffice/task/btk_abc123')).toEqual({
      kind: 'task',
      id: 'btk_abc123'
    })
    expect(parseBackofficeLink('orca://backoffice/thread/hth_Ab-c_9')).toEqual({
      kind: 'thread',
      id: 'hth_Ab-c_9'
    })
  })

  it('rejects a thread id outside the handoff shape and unknown segments', () => {
    expect(parseBackofficeLink('omni://backoffice/thread/btk_abc123')).toBeNull()
    expect(parseBackofficeLink('omni://backoffice/thread/hth_')).toBeNull()
    expect(parseBackofficeLink(`omni://backoffice/thread/hth_${'a'.repeat(129)}`)).toBeNull()
    expect(parseBackofficeLink('omni://backoffice/thread/hth_a%20b')).toBeNull()
    expect(parseBackofficeLink('omni://backoffice/thread/hth_abc/extra')).toBeNull()
    expect(parseBackofficeLink('omni://backoffice/room/hth_abc')).toBeNull()
  })

  it('turns a link into the open target the renderer focuses', () => {
    expect(backofficeOpenTarget({ kind: 'task', id: 'btk_abc123' })).toEqual({
      taskId: 'btk_abc123'
    })
    expect(backofficeOpenTarget({ kind: 'thread', id: 'hth_abc' })).toEqual({
      threadId: 'hth_abc'
    })
  })
})

describe('session links', () => {
  it('opens a session by its ledger id only', () => {
    const link = parseBackofficeLink('omni://backoffice/session/als_0123456789abcdef01234567')
    expect(link).toEqual({ kind: 'session', id: 'als_0123456789abcdef01234567' })
    expect(backofficeOpenTarget(link!)).toEqual({ sessionLedgerId: 'als_0123456789abcdef01234567' })
    expect(parseBackofficeLink('omni://backoffice/session/als_short')).toBeNull()
    expect(parseBackofficeLink('omni://backoffice/session/claude-uuid')).toBeNull()
    expect(
      parseBackofficeTaskId('omni://backoffice/session/als_0123456789abcdef01234567')
    ).toBeNull()
  })
})
