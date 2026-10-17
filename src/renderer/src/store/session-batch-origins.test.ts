import { beforeEach, describe, expect, it, vi } from 'vitest'
const scope = vi.hoisted(() => ({ key: 'alice' }))
vi.mock('@/lib/personal-view-storage', () => ({ personalViewStorageKey: () => scope.key }))
import {
  SESSION_BATCH_ORIGIN_SESSION_LIMIT,
  parseSessionBatchOrigins,
  recordSessionBatchSession,
  emptySessionBatchOrigins
} from '@/lib/session-batch-origins'
import { createSessionBatchOriginsStore } from './session-batch-origins'

beforeEach(() => {
  scope.key = 'alice'
})

function storage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    }
  }
}

const FOLDER = {
  folderId: 'folder-1',
  batchId: 'batch-1',
  requestExcerpt: 'fix PDF export, Refer & Earn copy',
  createdAt: 1_700_000_000_000,
  source: 'session-prep' as const
}

describe('session batch origin store', () => {
  it('keeps folder and session origins through a restart', () => {
    const backing = storage()
    const first = createSessionBatchOriginsStore(
      () => backing,
      () => 42
    )
    first.getState().record({ kind: 'recordBatchFolder', origin: FOLDER })
    first.getState().record({
      kind: 'recordBatchSession',
      sessionKey: 'term:tab-1:pane-1',
      origin: { batchId: 'batch-1', index: 3 }
    })
    const second = createSessionBatchOriginsStore(() => backing)
    second.getState().load()
    expect(second.getState().data).toEqual({
      version: 1,
      folders: { 'folder-1': FOLDER },
      sessions: { 'term:tab-1:pane-1': { batchId: 'batch-1', index: 3, at: 42 } }
    })
  })

  it('follows a session to its durable key, and keeps an origin already there', () => {
    const backing = storage()
    const store = createSessionBatchOriginsStore(
      () => backing,
      () => 1
    )
    store.getState().record({
      kind: 'recordBatchSession',
      sessionKey: 'pane-key',
      origin: { batchId: 'batch-1', index: 0 }
    })
    store.getState().migrateSessionKey('pane-key', 'claude:provider-session')
    expect(store.getState().data.sessions).toEqual({
      'claude:provider-session': { batchId: 'batch-1', index: 0, at: 1 }
    })
    const reloaded = createSessionBatchOriginsStore(() => backing)
    reloaded.getState().load()
    expect(Object.keys(reloaded.getState().data.sessions)).toEqual(['claude:provider-session'])

    store.getState().record({
      kind: 'recordBatchSession',
      sessionKey: 'other-pane',
      origin: { batchId: 'batch-2', index: 5 }
    })
    store.getState().migrateSessionKey('other-pane', 'claude:provider-session')
    expect(store.getState().data.sessions).toEqual({
      'claude:provider-session': { batchId: 'batch-1', index: 0, at: 1 }
    })
  })

  it('keeps each account on this device to its own origins', () => {
    const backing = storage()
    const store = createSessionBatchOriginsStore(() => backing)
    store.getState().record({ kind: 'recordBatchFolder', origin: FOLDER })
    scope.key = 'bob'
    store.getState().load()
    expect(store.getState().data.folders).toEqual({})
  })

  it('reads damaged storage as no origins, so every folder stays the person’s', () => {
    const backing = storage()
    backing.values.set('alice', '{not json')
    const store = createSessionBatchOriginsStore(() => backing)
    store.getState().load()
    expect(store.getState().data).toEqual(emptySessionBatchOrigins())
  })
})

describe('reading origins for the steward', () => {
  it('reads what was recorded, reloading when the personal view changed', () => {
    const backing = storage()
    const store = createSessionBatchOriginsStore(() => backing)
    store.getState().record({ kind: 'recordBatchFolder', origin: FOLDER })
    expect(store.getState().read().folders).toEqual({ 'folder-1': FOLDER })
    scope.key = 'bob'
    expect(store.getState().read().folders).toEqual({})
  })
})

describe('parseSessionBatchOrigins', () => {
  it('drops only the damaged entries', () => {
    expect(
      parseSessionBatchOrigins({
        version: 1,
        folders: { 'folder-1': FOLDER, 'folder-2': { ...FOLDER, source: 'steward' } },
        sessions: { good: { batchId: 'b', index: 1, at: 2 }, bad: { batchId: 'b', index: -1 } }
      })
    ).toEqual({
      version: 1,
      folders: { 'folder-1': FOLDER },
      sessions: { good: { batchId: 'b', index: 1, at: 2 } }
    })
  })

  it('keeps a session marked independent', () => {
    expect(
      recordSessionBatchSession(
        emptySessionBatchOrigins(),
        's',
        { batchId: 'b', index: 1, independent: true },
        5
      ).sessions
    ).toEqual({ s: { batchId: 'b', index: 1, independent: true, at: 5 } })
    expect(
      parseSessionBatchOrigins({
        version: 1,
        folders: {},
        sessions: { s: { batchId: 'b', index: 1, independent: true, at: 5 } }
      }).sessions.s?.independent
    ).toBe(true)
  })

  it('keeps the newest sessions when the store is full', () => {
    let data = emptySessionBatchOrigins()
    for (let at = 0; at <= SESSION_BATCH_ORIGIN_SESSION_LIMIT; at += 1) {
      data = recordSessionBatchSession(data, `s-${at}`, { batchId: 'b', index: 0 }, at)
    }
    expect(Object.keys(data.sessions)).toHaveLength(SESSION_BATCH_ORIGIN_SESSION_LIMIT)
    expect(data.sessions['s-0']).toBeUndefined()
    expect(data.sessions[`s-${SESSION_BATCH_ORIGIN_SESSION_LIMIT}`]).toBeDefined()
  })
})
