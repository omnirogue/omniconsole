import { beforeEach, describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import {
  applyDaemonSessionIdentities,
  getHibernationBoundaryResolvedAtByPaneKey,
  getHibernationPaneTouch,
  getHibernationPaneTouchStamps,
  getHibernationPtyBindingFirstSeenAtByPaneKey,
  needsDaemonSessionIdentities,
  observeHibernationPtyBindings,
  PTY_BINDING_AGE_STORAGE_KEY,
  recordHibernationBoundaryResolved,
  resetHibernationPaneAgeForTests,
  setHibernationPaneAgeStorageForTests,
  simulateHibernationPaneAgeRestartForTests
} from './agent-hibernation-pane-age'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`
const IDLE_MS = 30 * 60 * 1000

function tab(id = 'tab-1'): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-bg',
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function layout(ptyId: string | null): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF },
    activeLeafId: LEAF,
    expandedLeafId: null,
    ptyIdsByLeafId: ptyId ? { [LEAF]: ptyId } : {}
  }
}

function observe(
  ptyId: string | null,
  now: number,
  tabs: TerminalTab[] = [tab()],
  touches?: { inputAt?: number; revealAt?: number }
): void {
  observeHibernationPtyBindings({
    tabsByWorktree: { 'wt-bg': tabs },
    terminalLayoutsByTabId: { 'tab-1': layout(ptyId) },
    now,
    idleMs: IDLE_MS,
    ...(touches
      ? {
          touches: {
            inputAtByPaneKey: { [PANE]: touches.inputAt },
            revealAtByTabId: { 'tab-1': touches.revealAt }
          }
        }
      : {})
  })
}

describe('hibernation PTY binding age', () => {
  beforeEach(() => {
    resetHibernationPaneAgeForTests()
  })

  it('stamps first sight and carries it while the PTY is unchanged', () => {
    observe('pty-1', 1_000)
    observe('pty-1', 500_000)
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(1_000)
  })

  it('resets the stamp when the pane rebinds to a new PTY', () => {
    // A wake spawns a fresh PTY; the pane must get a full idle window again.
    observe('pty-1', 1_000)
    observe('pty-2', 500_000)
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(500_000)
  })

  it('keeps accumulated age across a transient layout gap', () => {
    // The planner already fails closed during the gap; dropping the binding here would
    // hand the same PTY a fresh idle window every time the layout flickers.
    observe('pty-1', 1_000)
    recordHibernationBoundaryResolved(PANE, 1_500)
    observe(null, 2_000)
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(1_000)
    expect(getHibernationBoundaryResolvedAtByPaneKey()[PANE]).toBe(1_500)
    observe('pty-1', 3_000)
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(1_000)
    expect(getHibernationBoundaryResolvedAtByPaneKey()[PANE]).toBe(1_500)
  })

  it('expires an unseen binding once it is older than the idle window', () => {
    observe('pty-1', 1_000)
    recordHibernationBoundaryResolved(PANE, 1_000)
    observe(null, 1_000 + IDLE_MS + 1)
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBeUndefined()
    expect(getHibernationBoundaryResolvedAtByPaneKey()[PANE]).toBeUndefined()
  })

  it('drops bindings and boundary stamps when the tab is authoritatively gone', () => {
    observe('pty-1', 1_000)
    recordHibernationBoundaryResolved(PANE, 1_000)
    observe(null, 2_000, [])
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBeUndefined()
    expect(getHibernationBoundaryResolvedAtByPaneKey()[PANE]).toBeUndefined()
  })
})

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  data: Map<string, string>
} {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

describe('hibernation PTY binding age across an app restart', () => {
  beforeEach(() => {
    resetHibernationPaneAgeForTests()
  })

  it('keeps the idle clock once the daemon shows the same PTY lifetime', () => {
    const storage = memoryStorage()
    setHibernationPaneAgeStorageForTests(storage)
    observe('pty-1', 1_000)
    applyDaemonSessionIdentities([{ sessionId: 'pty-1', incarnationId: 'lifetime-a', pid: 41 }])
    // The daemon PTY survives the relaunch; the window's memory does not.
    simulateHibernationPaneAgeRestartForTests()
    observe('pty-1', 500_000)
    // Unproven yet: a fresh window, and one daemon listing is asked for.
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(500_000)
    expect(needsDaemonSessionIdentities()).toBe(true)
    applyDaemonSessionIdentities([{ sessionId: 'pty-1', incarnationId: 'lifetime-a', pid: 41 }])
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(1_000)
    expect(needsDaemonSessionIdentities()).toBe(false)
  })

  it.each<[string, Parameters<typeof applyDaemonSessionIdentities>[0]]>([
    ['a cold restore reused the PTY id', [{ sessionId: 'pty-1', incarnationId: 'lifetime-b' }]],
    ['the daemon no longer lists the PTY (it died; the pane restores later)', []],
    ['the daemon listing failed', null]
  ])('starts a fresh window after a restart when %s', (_label, sessions) => {
    setHibernationPaneAgeStorageForTests(memoryStorage())
    observe('pty-1', 1_000)
    applyDaemonSessionIdentities([{ sessionId: 'pty-1', incarnationId: 'lifetime-a' }])
    simulateHibernationPaneAgeRestartForTests()
    observe('pty-1', 500_000)
    applyDaemonSessionIdentities(sessions)
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(500_000)
    // The fresh stamp is what the next restart carries.
    simulateHibernationPaneAgeRestartForTests()
    observe('pty-1', 900_000)
    applyDaemonSessionIdentities([{ sessionId: 'pty-1', incarnationId: 'lifetime-b' }])
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(
      sessions?.length ? 500_000 : 900_000
    )
  })

  it('names a lifetime by its pid when the daemon reports no incarnation', () => {
    setHibernationPaneAgeStorageForTests(memoryStorage())
    observe('pty-1', 1_000)
    applyDaemonSessionIdentities([{ sessionId: 'pty-1', pid: 41 }])
    simulateHibernationPaneAgeRestartForTests()
    observe('pty-1', 500_000)
    applyDaemonSessionIdentities([{ sessionId: 'pty-1', pid: 77 }])
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(500_000)
  })

  it('never proves a stamp whose earlier lifetime was never named', () => {
    // A stored stamp from before lifetimes were recorded, or from a pane the daemon never listed.
    setHibernationPaneAgeStorageForTests(memoryStorage())
    observe('pty-1', 1_000)
    simulateHibernationPaneAgeRestartForTests()
    observe('pty-1', 500_000)
    applyDaemonSessionIdentities([{ sessionId: 'pty-1', incarnationId: 'lifetime-a' }])
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(500_000)
  })

  it('keeps an unproven stamp stored, so a quit before the listing loses nothing', () => {
    setHibernationPaneAgeStorageForTests(memoryStorage())
    observe('pty-1', 1_000)
    applyDaemonSessionIdentities([{ sessionId: 'pty-1', incarnationId: 'lifetime-a' }])
    simulateHibernationPaneAgeRestartForTests()
    // A touch rewrites storage before any listing answered.
    observe('pty-1', 500_000, [tab()], { inputAt: 400_000 })
    simulateHibernationPaneAgeRestartForTests()
    observe('pty-1', 600_000)
    applyDaemonSessionIdentities([{ sessionId: 'pty-1', incarnationId: 'lifetime-a' }])
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(1_000)
  })

  it('never asks the local daemon about a remote runtime PTY', () => {
    setHibernationPaneAgeStorageForTests(memoryStorage())
    observe('remote:env-1@@pty-1', 1_000)
    expect(needsDaemonSessionIdentities()).toBe(false)
  })

  it('starts a fresh window when the restart brought the pane back on a new PTY', () => {
    setHibernationPaneAgeStorageForTests(memoryStorage())
    observe('pty-1', 1_000)
    applyDaemonSessionIdentities([{ sessionId: 'pty-1', incarnationId: 'lifetime-a' }])
    simulateHibernationPaneAgeRestartForTests()
    observe('pty-2', 500_000)
    applyDaemonSessionIdentities([{ sessionId: 'pty-2', incarnationId: 'lifetime-a' }])
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(500_000)
  })

  it('uses a stored stamp only once, for the first sight after the restart', () => {
    setHibernationPaneAgeStorageForTests(memoryStorage())
    observe('pty-1', 1_000)
    simulateHibernationPaneAgeRestartForTests()
    observe('pty-2', 500_000)
    observe('pty-1', 600_000)
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(600_000)
  })

  it('ignores unreadable or future stamps and survives a storage that throws', () => {
    const storage = memoryStorage()
    storage.data.set(
      PTY_BINDING_AGE_STORAGE_KEY,
      JSON.stringify({ [PANE]: { ptyId: 'pty-1', firstSeenAt: 9_000_000 } })
    )
    setHibernationPaneAgeStorageForTests(storage)
    observe('pty-1', 1_000)
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(1_000)

    simulateHibernationPaneAgeRestartForTests()
    setHibernationPaneAgeStorageForTests({
      getItem: () => '{not json',
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {}
    })
    expect(() => observe('pty-1', 2_000)).not.toThrow()
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(2_000)
  })

  it('carries the last keystroke and reveal of a pane still on the same PTY', () => {
    setHibernationPaneAgeStorageForTests(memoryStorage())
    observe('pty-1', 1_000, [tab()], { inputAt: 2_000, revealAt: 3_000 })
    simulateHibernationPaneAgeRestartForTests()
    // The window's own stamps start empty after a restart.
    observe('pty-1', 500_000, [tab()], {})
    expect(getHibernationPaneTouch(PANE)).toEqual({ inputAt: 2_000, revealAt: 3_000 })
    expect(getHibernationPaneTouchStamps()).toEqual({
      inputAtByPaneKey: { [PANE]: 2_000 },
      revealAtByTabId: { 'tab-1': 3_000 }
    })
  })

  it('drops carried stamps when the pane comes back on a new PTY', () => {
    setHibernationPaneAgeStorageForTests(memoryStorage())
    observe('pty-1', 1_000, [tab()], { inputAt: 2_000, revealAt: 3_000 })
    simulateHibernationPaneAgeRestartForTests()
    observe('pty-2', 500_000, [tab()], {})
    expect(getHibernationPaneTouch(PANE)).toEqual({ inputAt: 0, revealAt: 0 })
  })
})
