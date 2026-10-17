/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionContextAttachment } from '../../../shared/session-context-attachments'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({}),
    subscribe: () => () => undefined
  })
}))
vi.mock('./console-account-scope', () => ({ selectConsoleAccountScope: () => 'acct' }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  getAgentDetectionTargetKeyForWorktree: () => 'local'
}))
vi.mock('./sidebar-sessions', () => ({ buildPaneSessions: () => [] }))

const STORAGE_KEY = 'omni.session-context.v1'
const MIGRATION_KEY = 'omni.session-context.launch-one-shot.v1'
const HOUR = 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 1, 12)
const doc: SessionContextAttachment = {
  id: 'omnios:closed-unanswered-replies',
  kind: 'omnios',
  title: 'Closed Unanswered Replies',
  uri: 'https://omnios.example/a/closed-unanswered-replies',
  content: 'Snapshot body',
  capturedAt: NOW - 30 * HOUR
}
const note: SessionContextAttachment = {
  id: 'instructions:1',
  kind: 'instructions',
  title: 'Ship small PRs',
  content: 'Ship small PRs'
}
const launchKey = (worktreeId: string | null) =>
  JSON.stringify(['acct', 'launch', 'local', worktreeId])
const conversationKey = JSON.stringify(['acct', 'session', 'local', 'pane-1'])

/** A fresh module instance reads storage again, as the next app start would. */
async function load() {
  vi.resetModules()
  return {
    ...(await import('./launch-session-context')),
    ...(await import('./session-context-store'))
  }
}

const saved = (): Record<string, unknown> =>
  JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>

beforeEach(() => {
  localStorage.clear()
  toastError.mockClear()
})

describe('one-shot launcher context', () => {
  it('rides on the next launch only and is cleared once that launch has started', async () => {
    const context = await load()
    const key = context.launchSessionContextKey(null)
    await context.setSessionContext(key, [doc])
    const { items, claim } = context.readLaunchSessionContext(null)
    expect(items).toEqual([doc])
    expect(claim).toEqual({ key, ids: [doc.id] })

    context.consumeLaunchSessionContext(claim)

    expect(context.getSessionContext(key)).toEqual([])
    expect(context.readLaunchSessionContext(null).claim).toBeUndefined()
    expect(saved()).toEqual({})
    expect(toastError).not.toHaveBeenCalled()
  })

  it('stays for the next launch until one has started, and keeps what was added meanwhile', async () => {
    const context = await load()
    const key = context.launchSessionContextKey('wt-1')
    await context.setSessionContext(key, [doc])
    const { claim } = context.readLaunchSessionContext('wt-1')
    // A failed or cancelled launch never consumes its claim.
    expect(context.readLaunchSessionContext('wt-1').items).toEqual([doc])

    await context.setSessionContext(key, [doc, note])
    context.consumeLaunchSessionContext(claim)

    expect(context.getSessionContext(key)).toEqual([note])
  })

  it('keeps pinned launcher context for every launch, across restarts, until unpinned', async () => {
    const context = await load()
    const key = context.launchSessionContextKey(null)
    await context.setSessionContext(key, [doc])
    context.setLaunchSessionContextPinned(key, true)
    context.consumeLaunchSessionContext(context.readLaunchSessionContext(null).claim)

    expect(context.getSessionContext(key)).toEqual([doc])
    expect(saved()[key]).toEqual({ items: [doc], pinned: true, savedAt: expect.any(Number) })

    const restarted = await load()
    expect(restarted.sessionContextMeta(key)?.pinned).toBe(true)
    restarted.consumeLaunchSessionContext(restarted.readLaunchSessionContext(null).claim)
    expect(restarted.getSessionContext(key)).toEqual([doc])

    restarted.setLaunchSessionContextPinned(key, false)
    restarted.consumeLaunchSessionContext(restarted.readLaunchSessionContext(null).claim)
    expect(restarted.getSessionContext(key)).toEqual([])
  })

  it('reads entries saved by older builds as not pinned, so they are used at most once more', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ [launchKey(null)]: [doc] }))
    const context = await load()
    expect(context.sessionContextMeta(launchKey(null))).toBeUndefined()

    context.consumeLaunchSessionContext(context.readLaunchSessionContext(null).claim)

    expect(saved()).toEqual({})
  })

  it('leaves conversation context alone when launcher context is emptied', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ [conversationKey]: [note] }))
    const context = await load()
    await context.setSessionContext(launchKey(null), [doc])
    await context.setSessionContext(launchKey(null), [])

    expect(saved()).toEqual({ [conversationKey]: [note] })
  })
})

describe('migrateLaunchSessionContext', () => {
  it('drops stale unpinned launcher entries once and keeps pinned and conversation keys', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        [launchKey(null)]: [doc],
        [launchKey('wt-recent')]: [{ ...doc, capturedAt: NOW - HOUR }],
        [launchKey('wt-untimed')]: [note],
        [launchKey('wt-saved')]: { items: [note], pinned: false, savedAt: NOW - 13 * HOUR },
        [launchKey('wt-pinned')]: { items: [doc], pinned: true, savedAt: NOW - 48 * HOUR },
        [conversationKey]: [doc]
      })
    )
    const context = await load()
    context.migrateLaunchSessionContext(NOW)

    expect(Object.keys(saved()).sort()).toEqual(
      [launchKey('wt-recent'), launchKey('wt-pinned'), conversationKey].sort()
    )
    expect(context.getSessionContext(launchKey(null))).toEqual([])
    expect(localStorage.getItem(MIGRATION_KEY)).toBe(String(NOW))

    // Once only: later launcher context follows the one-shot rule instead.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved(), [launchKey(null)]: [note] }))
    const restarted = await load()
    restarted.migrateLaunchSessionContext(NOW + 24 * HOUR)
    expect(saved()[launchKey(null)]).toEqual([note])
  })

  it('leaves unreadable storage untouched and retries at the next start', async () => {
    localStorage.setItem(STORAGE_KEY, 'not json')
    const context = await load()
    context.migrateLaunchSessionContext(NOW)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('not json')
    expect(localStorage.getItem(MIGRATION_KEY)).toBeNull()

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ [launchKey(null)]: [doc] }))
    const restarted = await load()
    restarted.migrateLaunchSessionContext(NOW)
    expect(saved()).toEqual({})
  })
})
