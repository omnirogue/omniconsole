import { describe, expect, it } from 'vitest'
import type { Synced, SyncedSessions } from '../../../../shared/account-sync-session-docs'
import { deviceDocKey, syncDocIndex } from '../../../../shared/account-sync-session-keys'
import { layout, plan } from './session-sync-layout'

const DEVICE = '0000000a'
const FOLDER = '11111111-1111-4111-8111-111111111111'

// The first four hex digits pick the document: 0x0001 and 0x0011 share one of 16, not of 32.
const STAYS = `0001${'0'.repeat(20)}`
const MOVES = `0011${'0'.repeat(20)}`

describe('session sync document layout and write plan', () => {
  it('keeps the document count and never shrinks it', () => {
    expect(layout('sessions', {}, 32).count).toBe(32)
    expect(layout('sessions', {}, 16).parts).toHaveLength(16)
  })

  it('drops a moved entry from its old document only once its new one holds it', () => {
    const [stays, moves] = [STAYS, MOVES]
    const was = syncDocIndex('sessions', stays, 16)
    const newHome = syncDocIndex('sessions', moves, 32)
    expect([was, syncDocIndex('sessions', moves, 16), newHome]).toEqual([1, 1, 17])
    const sessions: SyncedSessions = {
      [stays]: { f: [FOLDER, 9] },
      [moves]: { f: [FOLDER, 5] }
    }
    const docs = {
      folders: { parts: [{}] },
      sessions: layout('sessions', sessions, 32)
    }
    const oldDoc: Synced = {
      sessions: { [stays]: { f: [FOLDER, 1] }, [moves]: { f: [FOLDER, 5] } },
      folders: {}
    }
    const stored = new Map([[deviceDocKey(DEVICE, 'sessions', was), oldDoc]])
    const first = plan(DEVICE, 'user', docs, stored)
    expect(first.adding.map((write) => write.key)).toEqual([
      deviceDocKey(DEVICE, 'sessions', newHome)
    ])
    expect(first.dropping.map((write) => write.key)).toEqual([
      deviceDocKey(DEVICE, 'sessions', was)
    ])
    // Once the new document holds it, the old one is rewritten without waiting on anything.
    stored.set(deviceDocKey(DEVICE, 'sessions', newHome), {
      sessions: { [moves]: { f: [FOLDER, 5] } },
      folders: {}
    })
    const later = plan(DEVICE, 'user', docs, stored)
    expect(later.adding.map((write) => write.key)).toEqual([deviceDocKey(DEVICE, 'sessions', was)])
    expect(later.dropping).toEqual([])
  })
})
