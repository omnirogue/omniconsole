import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { resetForegroundTerminalTabIdsForTests } from '@/lib/foreground-terminal-tabs'
import { resetPersonRevealsForTests, notePersonRevealedTab } from '@/lib/restore-flood-guard'
import { planColdActivationTabDeferral } from './background-terminal-worktree-mount'
import {
  collectGuardDeferrableRestoredTabIds,
  isGuardDeferrableRestoredTab,
  mountGuardDeferredTabsWithLivePty,
  type ActivationDeferralState
} from './restore-flood-activation-deferral'

const LEAF = '11111111-1111-4111-8111-111111111111'
const NOW = 2_000_000_000

function tab(index: number): { id: string; ptyId: string | null } {
  return { id: `tab-${index}`, ptyId: `wt-1@@lost${index}` }
}

function sleepRecord(tabId: string, overrides: Record<string, unknown> = {}) {
  return {
    paneKey: makePaneKey(tabId, LEAF),
    tabId,
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: `thread-${tabId}` },
    prompt: '',
    state: 'done',
    capturedAt: NOW - 3_600_000,
    updatedAt: NOW - 3_600_000,
    origin: 'worktree-sleep',
    ...overrides
  }
}

function restoredState(
  tabs: { id: string; ptyId: string | null }[],
  overrides: Partial<ActivationDeferralState> = {}
): ActivationDeferralState {
  return {
    settings: {},
    ptyIdsByTabId: {},
    pendingStartupByTabId: {},
    terminalLayoutsByTabId: {},
    sleepingAgentSessionsByPaneKey: Object.fromEntries(
      tabs.map((entry) => [makePaneKey(entry.id, LEAF), sleepRecord(entry.id)])
    ) as never,
    agentStatusByPaneKey: {},
    ...overrides
  }
}

const notLive = (): boolean => false

afterEach(() => {
  resetForegroundTerminalTabIdsForTests()
  resetPersonRevealsForTests()
})

describe('cold activation under the restore flood guard', () => {
  it('leaves 50 of 51 restored tabs with dead PTYs unmounted; only the shown tab mounts', () => {
    const tabs = Array.from({ length: 51 }, (_, index) => tab(index))
    const state = restoredState(tabs)
    const immediateTabIds = new Set(['tab-0'])
    const deferrable = collectGuardDeferrableRestoredTabIds({
      state,
      tabs: tabs.filter((entry) => !immediateTabIds.has(entry.id)),
      isTabLive: notLive,
      now: NOW
    })
    expect(deferrable.size).toBe(50)

    const restrictions = new Map<string, ReadonlySet<string>>()
    const deferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>()
    const deferred = planColdActivationTabDeferral({
      restrictions,
      deferredMountTabIdsByWorktree,
      worktreeId: 'wt-1',
      allTabIds: tabs.map((entry) => entry.id),
      isTabLive: notLive,
      isTabDeferrable: (tabId) => deferrable.has(tabId),
      immediateTabIds
    })
    expect(deferred).toBe(true)
    expect([...(restrictions.get('wt-1') ?? [])]).toEqual(['tab-0'])
    expect(deferredMountTabIdsByWorktree.get('wt-1')?.size).toBe(50)
  })

  it('never defers a tab with a startup queued in this app session, or a live PTY', () => {
    const tabs = [tab(1), tab(2), tab(3)]
    const state = restoredState(tabs, {
      pendingStartupByTabId: { 'tab-1': { command: 'codex' } },
      ptyIdsByTabId: { 'tab-2': ['wt-1@@lost2'] }
    })
    expect(isGuardDeferrableRestoredTab(tabs[0], state, notLive, NOW)).toBe(false)
    expect(isGuardDeferrableRestoredTab(tabs[1], state, notLive, NOW)).toBe(false)
    expect(isGuardDeferrableRestoredTab(tabs[2], state, (id) => id === 'tab-3', NOW)).toBe(false)
  })

  it('keeps G5 mid-task, live-asking and G2 recently touched tabs eager', () => {
    const tabs = [tab(1), tab(2), tab(3), tab(4), tab(5), tab(6)]
    const state = restoredState(tabs, {
      lastTerminalInputAtByPaneKey: { [makePaneKey('tab-3', LEAF)]: NOW - 60_000 },
      agentStatusByPaneKey: {
        [makePaneKey('tab-6', LEAF)]: {
          paneKey: makePaneKey('tab-6', LEAF),
          state: 'blocked',
          interactivePrompt: 'Allow git push?'
        }
      } as never
    })
    Object.assign(state.sleepingAgentSessionsByPaneKey[makePaneKey('tab-1', LEAF)], {
      origin: 'quit',
      state: 'working'
    })
    // A last message that reads like an ask (or an ordinary numbered summary) is no reason to
    // resume from the background: the record keeps it resumable and the reveal resumes it.
    Object.assign(state.sleepingAgentSessionsByPaneKey[makePaneKey('tab-2', LEAF)], {
      lastAssistantMessage: 'Which of these?\n1. A\n2. B'
    })
    notePersonRevealedTab('tab-4', NOW - 5 * 60_000)
    const deferrable = collectGuardDeferrableRestoredTabIds({
      state,
      tabs,
      isTabLive: notLive,
      now: NOW
    })
    expect([...deferrable].sort()).toEqual(['tab-2', 'tab-5'])
  })

  it('defers a slept tab whose working or asking row came back from last-status.json', () => {
    const tabs = [tab(1), tab(2), tab(3)]
    const row = (index: number, fields: Record<string, unknown>) => ({
      paneKey: makePaneKey(`tab-${index}`, LEAF),
      ...fields
    })
    // Main restores each pane's last hook row after a restart (restoredUnconfirmed): no proof of a
    // turn or of an ask. tab-3's row is live: its hook reported since the restart.
    const state = restoredState(tabs, {
      agentStatusByPaneKey: {
        [makePaneKey('tab-1', LEAF)]: row(1, { state: 'working', restoredUnconfirmed: true }),
        [makePaneKey('tab-2', LEAF)]: row(2, {
          state: 'blocked',
          interactivePrompt: 'Allow git push?',
          restoredUnconfirmed: true
        }),
        [makePaneKey('tab-3', LEAF)]: row(3, { state: 'working' })
      } as never
    })
    const deferrable = collectGuardDeferrableRestoredTabIds({
      state,
      tabs,
      isTabLive: notLive,
      now: NOW
    })
    expect([...deferrable].sort()).toEqual(['tab-1', 'tab-2'])
  })

  it('defers a mid-task agent the person archived, hid or deleted (#921), keeps the rest eager', () => {
    const tabs = [tab(1), tab(2), tab(3)]
    const state = restoredState(tabs)
    for (const index of [1, 2]) {
      Object.assign(state.sleepingAgentSessionsByPaneKey[makePaneKey(`tab-${index}`, LEAF)], {
        origin: 'quit',
        state: 'working'
      })
    }
    // tab-3's agent was mid-turn by its (restored) status row, with no working record.
    state.agentStatusByPaneKey = {
      [makePaneKey('tab-3', LEAF)]: {
        paneKey: makePaneKey('tab-3', LEAF),
        state: 'working'
      }
    } as never
    const archived = new Set<string>([makePaneKey('tab-1', LEAF), makePaneKey('tab-3', LEAF)])
    const deferrable = collectGuardDeferrableRestoredTabIds({
      state,
      tabs,
      isTabLive: notLive,
      now: NOW,
      isPutAway: (paneKey) => archived.has(paneKey)
    })
    expect([...deferrable].sort()).toEqual(['tab-1', 'tab-3'])
  })

  it('leaves new tabs and other hosts alone, and does nothing with the guard off', () => {
    const fresh = { id: 'tab-new', ptyId: null }
    const ssh = { id: 'tab-ssh', ptyId: 'ssh:conn-1@@pty-1' }
    const remote = { id: 'tab-remote', ptyId: 'remote:env-1@@pty-1' }
    // A tab with neither a recorded PTY nor a record is new: it mounts to spawn its shell.
    expect(isGuardDeferrableRestoredTab(fresh, restoredState([]), notLive, NOW)).toBe(false)
    // pty:hasPty cannot vouch for another host's PTY, so those tabs keep their eager mount.
    expect(isGuardDeferrableRestoredTab(ssh, restoredState([ssh]), notLive, NOW)).toBe(false)
    expect(isGuardDeferrableRestoredTab(remote, restoredState([remote]), notLive, NOW)).toBe(false)
    const tabs = [tab(1)]
    expect(
      collectGuardDeferrableRestoredTabIds({
        state: restoredState(tabs, { settings: { restoreFloodGuard: false } }),
        tabs,
        isTabLive: notLive,
        now: NOW
      }).size
    ).toBe(0)
  })

  it('leaves watcher-coverable tabs to the parked-watcher deferral: never probed or mounted', async () => {
    // The daemon kept 40 idle agents alive across the restart; parked watchers cover each tab.
    const tabs = Array.from({ length: 40 }, (_, index) => tab(index))
    const coverable = new Set(tabs.slice(0, 39).map((entry) => entry.id))
    const deferrable = collectGuardDeferrableRestoredTabIds({
      state: restoredState(tabs),
      tabs,
      isTabLive: notLive,
      isWatcherCoverable: (entry) => coverable.has(entry.id),
      now: NOW
    })
    // Only the tab watchers cannot cover is the guard's to defer.
    expect([...deferrable]).toEqual(['tab-39'])

    const hasPty = vi.fn(async () => true)
    const requestMount = vi.fn()
    await mountGuardDeferredTabsWithLivePty({
      worktreeId: 'wt-1',
      tabs: tabs.filter((entry) => deferrable.has(entry.id)),
      state: { terminalLayoutsByTabId: {} },
      hasPty,
      requestMount
    })
    // A coverable tab with a live PTY stays unmounted (no eager xterm + snapshot replay storm).
    expect(requestMount.mock.calls).toEqual([[{ worktreeId: 'wt-1', tabIds: ['tab-39'] }]])
    expect(hasPty).toHaveBeenCalledTimes(1)

    // Both kinds still defer at activation, so nothing mounts before a reveal.
    const restrictions = new Map<string, ReadonlySet<string>>()
    const deferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>()
    planColdActivationTabDeferral({
      restrictions,
      deferredMountTabIdsByWorktree,
      worktreeId: 'wt-1',
      allTabIds: tabs.map((entry) => entry.id),
      isTabLive: notLive,
      isTabDeferrable: (tabId) => deferrable.has(tabId) || coverable.has(tabId),
      immediateTabIds: new Set()
    })
    expect(deferredMountTabIdsByWorktree.get('wt-1')?.size).toBe(40)
  })

  it('mounts a deferred tab at once when the provider still runs its PTY', async () => {
    const tabs = [tab(1), tab(2), { id: 'tab-3', ptyId: null }]
    const hasPty = vi.fn(async (ptyId: string) =>
      ptyId === 'wt-1@@lost2' ? true : ptyId === 'wt-1@@lost1' ? null : false
    )
    const requestMount = vi.fn()
    const mounted = await mountGuardDeferredTabsWithLivePty({
      worktreeId: 'wt-1',
      tabs,
      state: { terminalLayoutsByTabId: {} },
      hasPty,
      requestMount
    })
    expect(mounted).toEqual(['tab-2'])
    expect(requestMount.mock.calls).toEqual([[{ worktreeId: 'wt-1', tabIds: ['tab-2'] }]])
    // A tab with no recorded PTY has nothing to ask about.
    expect(hasPty).toHaveBeenCalledTimes(2)
  })
})
