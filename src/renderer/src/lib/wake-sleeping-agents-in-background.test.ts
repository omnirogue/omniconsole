// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type BackgroundMountTerminalWorktreeDetail,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'
import type { ResumeSleepingAgentSessionsOptions } from './resume-sleeping-agent-session'

const resumeSpy = vi.fn<
  (worktreeId: string, options?: ResumeSleepingAgentSessionsOptions) => number
>(() => 0)
vi.mock('./resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: (
    worktreeId: string,
    options?: ResumeSleepingAgentSessionsOptions
  ) => resumeSpy(worktreeId, options)
}))

// Why: control passive-vs-non-passive classification directly so the test asserts
// the gating, not the predicate internals.
const isPassiveSpy = vi.fn()
vi.mock('./sleeping-agent-pane-ownership', () => ({
  isPassiveCompletedHibernationEvidence: (record: unknown) => isPassiveSpy(record),
  recordPaneIsOwnedByPreservedPane: () => false,
  recordAwaitsFirstRevealInOwnTab: (record: { resumeOnFirstReveal?: true }) =>
    record.resumeOnFirstReveal === true,
  getProviderSessionClaimKey: (record: {
    worktreeId: string
    agent?: string
    providerSession?: { key?: string; id?: string }
  }) =>
    `${record.worktreeId}\0${record.agent ?? 'agent'}\0${record.providerSession?.key ?? 'session_id'}\0${record.providerSession?.id ?? 'session'}`
}))

let sleepingRecords: Record<
  string,
  {
    worktreeId: string
    paneKey: string
    tabId?: string
    resumeOnFirstReveal?: true
    restoreOnTabOpenOnly?: boolean
    origin?: 'worktree-sleep' | 'quit' | 'live'
    state?: 'working' | 'blocked' | 'waiting' | 'done'
    capturedAt?: number
    providerSession?: { key: string; id: string }
    lastAssistantMessage?: string
  }
> = {}
let lastTerminalInputAtByPaneKey: Record<string, number> = {}
let terminalTabsByWorktree: Record<string, { id: string }[]> = {}
let pendingStartupByTabId: Record<string, { deferUntilRevealed?: true }> = {}
let agentStatusByPaneKey: Record<string, Record<string, unknown>> = {}
// Why: most cases cover the eager phone wake that runs with the restore flood guard off.
let storeSettings: { restoreFloodGuard?: boolean } = { restoreFloodGuard: false }
const clearSleepingAgentSessionsByPaneKey = vi.fn((paneKeys: readonly string[]) => {
  for (const paneKey of paneKeys) {
    delete sleepingRecords[paneKey]
  }
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      sleepingAgentSessionsByPaneKey: sleepingRecords,
      tabsByWorktree: terminalTabsByWorktree,
      clearSleepingAgentSessionsByPaneKey,
      settings: storeSettings,
      pendingStartupByTabId,
      lastTerminalInputAtByPaneKey,
      agentStatusByPaneKey
    })
  }
}))

import {
  createBackgroundSleepingAgentWakeDispatcher,
  wakeSleepingAgentsForWorktreeInBackground
} from './wake-sleeping-agents-in-background'

type RecordedEvents = {
  events: string[]
  mountDetails: BackgroundMountTerminalWorktreeDetail[]
  wakeDetails: WakeHibernatedAgentsWorktreeDetail[]
  stop: () => void
}

function recordEvents(): RecordedEvents {
  const events: string[] = []
  const mountDetails: BackgroundMountTerminalWorktreeDetail[] = []
  const wakeDetails: WakeHibernatedAgentsWorktreeDetail[] = []
  const onWake = (event: Event): void => {
    const detail = (event as CustomEvent<WakeHibernatedAgentsWorktreeDetail>).detail
    events.push(`wake:${detail.worktreeId}`)
    wakeDetails.push(detail)
  }
  const onMount = (event: Event): void => {
    const detail = (event as CustomEvent<BackgroundMountTerminalWorktreeDetail>).detail
    events.push(`mount:${detail.worktreeId}`)
    mountDetails.push(detail)
  }
  window.addEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWake)
  window.addEventListener(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, onMount)
  return {
    events,
    mountDetails,
    wakeDetails,
    stop: () => {
      window.removeEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWake)
      window.removeEventListener(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, onMount)
    }
  }
}

beforeEach(() => {
  sleepingRecords = {}
  terminalTabsByWorktree = {}
  pendingStartupByTabId = {}
  agentStatusByPaneKey = {}
  lastTerminalInputAtByPaneKey = {}
  storeSettings = { restoreFloodGuard: false }
  clearSleepingAgentSessionsByPaneKey.mockClear()
  isPassiveSpy.mockReset()
  resumeSpy.mockReset()
  resumeSpy.mockReturnValue(0)
})

afterEach(() => {
  resumeSpy.mockReset()
})

describe('createBackgroundSleepingAgentWakeDispatcher', () => {
  it('deduplicates early wakes and drains them once workspace hydration completes', () => {
    let workspaceSessionReady = false
    let readinessListener: (() => void) | null = null
    const unsubscribe = vi.fn()
    const wake = vi.fn()
    const dispatcher = createBackgroundSleepingAgentWakeDispatcher({
      isWorkspaceSessionReady: () => workspaceSessionReady,
      subscribeToStore: (listener) => {
        readinessListener = listener
        return unsubscribe
      },
      wake
    })

    dispatcher.request('wt-cold')
    dispatcher.request('wt-cold')
    expect(wake).not.toHaveBeenCalled()

    workspaceSessionReady = true
    ;(readinessListener as unknown as () => void)()

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(wake).toHaveBeenCalledOnce()
    expect(wake).toHaveBeenCalledWith('wt-cold')

    dispatcher.request('wt-ready')
    expect(wake).toHaveBeenLastCalledWith('wt-ready')
    dispatcher.dispose()
  })
})

describe('wakeSleepingAgentsForWorktreeInBackground', () => {
  it('fires wake, targeted background-mount, then resume when a passive record exists', () => {
    sleepingRecords = { k1: { worktreeId: 'wt-1', paneKey: 'tab-a:leaf-1', tabId: 'tab-a' } }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // (a) pane-level wake of mounted hidden panes fires before (b) background-mount
    // of not-yet-mounted panes.
    expect(rec.events).toEqual(['wake:wt-1', 'mount:wt-1'])
    // Why: the mount targets only the sleeping record's tab, so one slept agent
    // does not permanently mount every saved tab in the worktree.
    expect(rec.mountDetails[0]?.tabIds).toEqual(['tab-a'])
    // (c) non-passive records resume with navigation suppressed (INV-2).
    expect(resumeSpy).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({ suppressNavigation: true })
    )
  })

  it('falls back to a whole-worktree mount when a passive record has no resolvable tab', () => {
    sleepingRecords = { k1: { worktreeId: 'wt-1', paneKey: 'not-a-pane-key' } }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    expect(rec.events).toEqual(['wake:wt-1', 'mount:wt-1'])
    expect(rec.mountDetails[0]?.tabIds).toBeUndefined()
  })

  it('mounts one canonical tab and clears cold aliases for the same provider session', () => {
    sleepingRecords = {
      'tab-a:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'tab-a:leaf-1',
        tabId: 'tab-a',
        capturedAt: 1,
        updatedAt: 1
      } as never,
      'tab-b:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'tab-b:leaf-1',
        tabId: 'tab-b',
        capturedAt: 2,
        updatedAt: 2
      } as never
    }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    expect(rec.mountDetails).toEqual([{ worktreeId: 'wt-1', tabIds: ['tab-a'] }])
    expect(clearSleepingAgentSessionsByPaneKey).toHaveBeenCalledWith(['tab-b:leaf-1'])
    expect(sleepingRecords).toHaveProperty('tab-a:leaf-1')
    expect(sleepingRecords).not.toHaveProperty('tab-b:leaf-1')
  })

  it('prefers a live duplicate tab when the oldest alias tab is gone', () => {
    sleepingRecords = {
      'missing-tab:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'missing-tab:leaf-1',
        tabId: 'missing-tab',
        capturedAt: 1,
        updatedAt: 1
      } as never,
      'live-tab:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'live-tab:leaf-1',
        tabId: 'live-tab',
        capturedAt: 2,
        updatedAt: 2
      } as never
    }
    terminalTabsByWorktree = { 'wt-1': [{ id: 'live-tab' }] }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    expect(rec.mountDetails).toEqual([{ worktreeId: 'wt-1', tabIds: ['live-tab'] }])
    expect(clearSleepingAgentSessionsByPaneKey).toHaveBeenCalledWith(['missing-tab:leaf-1'])
  })

  it('clears many cold aliases in one store action', () => {
    sleepingRecords = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => {
        const tabId = `tab-${index}`
        return [
          `${tabId}:leaf-1`,
          {
            worktreeId: 'wt-1',
            paneKey: `${tabId}:leaf-1`,
            tabId,
            capturedAt: index,
            updatedAt: index
          } as never
        ]
      })
    )
    isPassiveSpy.mockReturnValue(true)

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    expect(clearSleepingAgentSessionsByPaneKey).toHaveBeenCalledOnce()
    expect(clearSleepingAgentSessionsByPaneKey.mock.calls[0]?.[0]).toHaveLength(99)
    expect(Object.keys(sleepingRecords)).toEqual(['tab-0:leaf-1'])
  })

  it('does not background-mount finished panes captured by an explicit workspace sleep', () => {
    sleepingRecords = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => {
        const tabId = `tab-${index}`
        return [
          `${tabId}:leaf-1`,
          {
            worktreeId: 'wt-1',
            paneKey: `${tabId}:leaf-1`,
            tabId,
            capturedAt: index,
            updatedAt: index,
            providerSession: { key: 'session_id', id: `session-${index}` },
            restoreOnTabOpenOnly: true
          } as never
        ]
      })
    )
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // Why: a phone opening a slept workspace must not respawn every agent the
    // user just slept; each pane cold-restores when its own tab is opened.
    expect(rec.events).toEqual(['wake:wt-1'])
    expect(rec.mountDetails).toEqual([])
    expect(Object.keys(sleepingRecords)).toHaveLength(12)
  })

  it('still background-mounts hibernated panes alongside lazily restored slept panes', () => {
    sleepingRecords = {
      'tab-slept:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'tab-slept:leaf-1',
        tabId: 'tab-slept',
        capturedAt: 1,
        updatedAt: 1,
        providerSession: { key: 'session_id', id: 'session-slept' },
        restoreOnTabOpenOnly: true
      } as never,
      'tab-hibernated:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'tab-hibernated:leaf-1',
        tabId: 'tab-hibernated',
        capturedAt: 2,
        updatedAt: 2,
        providerSession: { key: 'session_id', id: 'session-hibernated' }
      } as never
    }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    expect(rec.mountDetails).toEqual([{ worktreeId: 'wt-1', tabIds: ['tab-hibernated'] }])
  })

  it('mounts the hibernated record when a lazily restored slept pane shares its claim', () => {
    sleepingRecords = {
      'tab-slept:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'tab-slept:leaf-1',
        tabId: 'tab-slept',
        capturedAt: 1,
        updatedAt: 1,
        providerSession: { key: 'session_id', id: 'session-shared' },
        restoreOnTabOpenOnly: true
      } as never,
      'tab-hibernated:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'tab-hibernated:leaf-1',
        tabId: 'tab-hibernated',
        capturedAt: 2,
        updatedAt: 2,
        providerSession: { key: 'session_id', id: 'session-shared' }
      } as never
    }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // Why: canonicalization deletes same-claim duplicates, so a lazy record must be filtered
    // out before it can win the claim and strand the hibernated pane it deletes.
    expect(rec.mountDetails).toEqual([{ worktreeId: 'wt-1', tabIds: ['tab-hibernated'] }])
    expect(clearSleepingAgentSessionsByPaneKey).not.toHaveBeenCalledWith(['tab-hibernated:leaf-1'])
    expect(sleepingRecords).toHaveProperty('tab-hibernated:leaf-1')
    expect(sleepingRecords).toHaveProperty('tab-slept:leaf-1')
  })

  it('background-mounts the tabs the suppressed resume launches for non-passive records', () => {
    sleepingRecords = { k1: { worktreeId: 'wt-1', paneKey: 'tab-a:leaf-1', tabId: 'tab-a' } }
    isPassiveSpy.mockReturnValue(false)
    resumeSpy.mockImplementation((_worktreeId, options) => {
      options?.onSessionLaunched?.('tab-new')
      return 1
    })
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // Why: the resume tab is created with activate:false, so nothing else
    // mounts it — without this mount the queued --resume never gets a PTY.
    expect(rec.events).toEqual(['wake:wt-1', 'mount:wt-1'])
    expect(rec.mountDetails[0]?.tabIds).toEqual(['tab-new'])
  })

  it('skips background-mount when only non-passive records exist and nothing launches', () => {
    sleepingRecords = { k1: { worktreeId: 'wt-1', paneKey: 'tab-a:leaf-1', tabId: 'tab-a' } }
    isPassiveSpy.mockReturnValue(false)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // Why: no passive record and no launched resume tab → nothing needs a
    // mount (it would strand a plain shell / mount work).
    expect(rec.events).toEqual(['wake:wt-1'])
    expect(resumeSpy).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({ suppressNavigation: true })
    )
  })

  it('mounts tabs a desktop activation restored lazily, so a phone wake stays eager', () => {
    sleepingRecords = {
      k1: { worktreeId: 'wt-1', paneKey: 'tab-a:leaf-1', tabId: 'tab-a', resumeOnFirstReveal: true }
    }
    isPassiveSpy.mockReturnValue(false)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    expect(rec.mountDetails).toEqual([{ worktreeId: 'wt-1', tabIds: ['tab-a'] }])
  })

  it('mounts, wakes and launches none of the agents automatic sleep put down', () => {
    sleepingRecords = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => {
        const tabId = `tab-${index}`
        return [
          `${tabId}:leaf-1`,
          {
            worktreeId: 'wt-1',
            paneKey: `${tabId}:leaf-1`,
            tabId,
            capturedAt: index + 1,
            updatedAt: index + 1,
            providerSession: { key: 'session_id', id: `session-${index}` },
            restoreOnTabOpenOnly: true,
            resumeOnFirstReveal: true
          } as never
        ]
      })
    )
    isPassiveSpy.mockReturnValue(true)
    const claimedAtWake: string[][] = []
    const onWake = (event: Event): void => {
      claimedAtWake.push([
        ...((event as CustomEvent<WakeHibernatedAgentsWorktreeDetail>).detail.wokenClaimKeys ?? [])
      ])
    }
    window.addEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWake)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    window.removeEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWake)
    // Every claim is taken before mounted panes see the wake, so none fires its armed --resume.
    expect(claimedAtWake[0]).toHaveLength(8)
    expect(claimedAtWake[0]).toContain('wt-1\0agent\0session_id\0session-3')
    expect(rec.mountDetails).toEqual([])
    expect(resumeSpy.mock.calls[0]?.[1]?.skipClaimKeys?.size).toBe(8)
    expect(Object.keys(sleepingRecords)).toHaveLength(8)
  })

  it('still wakes a hibernated record beside an automatic sleep of another session', () => {
    sleepingRecords = {
      'tab-auto:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'tab-auto:leaf-1',
        tabId: 'tab-auto',
        providerSession: { key: 'session_id', id: 'session-auto' },
        restoreOnTabOpenOnly: true,
        resumeOnFirstReveal: true
      } as never,
      'tab-old:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'tab-old:leaf-1',
        tabId: 'tab-old',
        providerSession: { key: 'session_id', id: 'session-old' }
      } as never
    }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    expect([...(rec.wakeDetails[0]?.wokenClaimKeys ?? [])]).toEqual([
      'wt-1\0agent\0session_id\0session-auto'
    ])
    expect(rec.mountDetails).toEqual([{ worktreeId: 'wt-1', tabIds: ['tab-old'] }])
  })

  it('passes claims consumed by mounted panes to the generic resume as skipClaimKeys', () => {
    sleepingRecords = { k1: { worktreeId: 'wt-1', paneKey: 'tab-a:leaf-1', tabId: 'tab-a' } }
    isPassiveSpy.mockReturnValue(false)
    // A mounted pane consuming the in-place wake adds its claim key to the
    // event detail — exactly what use-terminal-pane-lifecycle does.
    const onWake = (event: Event): void => {
      ;(event as CustomEvent<WakeHibernatedAgentsWorktreeDetail>).detail.wokenClaimKeys?.add(
        'claim-1'
      )
    }
    window.addEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWake)

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    window.removeEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWake)
    const options = resumeSpy.mock.calls[0]?.[1]
    expect(options?.skipClaimKeys?.has('claim-1')).toBe(true)
  })

  it('does nothing when the worktree has no sleeping records', () => {
    sleepingRecords = { k1: { worktreeId: 'other-wt', paneKey: 'tab-a:leaf-1' } }
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // Why: mobile browsing a worktree with nothing slept must not mount it (and
    // its PTYs) on the desktop host.
    expect(rec.events).toEqual([])
    expect(resumeSpy).not.toHaveBeenCalled()
    expect(isPassiveSpy).not.toHaveBeenCalled()
  })
})

describe('wakeSleepingAgentsForWorktreeInBackground with the restore flood guard on', () => {
  type WakeRecord = Parameters<
    NonNullable<ResumeSleepingAgentSessionsOptions['deferStartupUntilRevealedFor']>
  >[0]
  function wakeRecord(overrides: Partial<WakeRecord> = {}): WakeRecord {
    return {
      worktreeId: 'wt-1',
      paneKey: 'tab-a:leaf-1',
      tabId: 'tab-a',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'thread-a' },
      prompt: '',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep',
      ...overrides
    } as WakeRecord
  }

  it('mounts no tab for plain finished or lazily restored agents, nor the whole worktree', () => {
    storeSettings = {}
    terminalTabsByWorktree = { 'wt-1': [{ id: 'tab-a' }, { id: 'tab-b' }] }
    sleepingRecords = {
      k1: {
        worktreeId: 'wt-1',
        paneKey: 'tab-a:leaf-1',
        tabId: 'tab-a',
        origin: 'worktree-sleep',
        state: 'done',
        capturedAt: 1
      },
      k2: {
        worktreeId: 'wt-1',
        paneKey: 'tab-b:leaf-1',
        tabId: 'tab-b',
        resumeOnFirstReveal: true,
        origin: 'quit',
        state: 'done',
        capturedAt: 1
      },
      k3: { worktreeId: 'wt-1', paneKey: 'legacy-pane' }
    }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // Why: the phone opening a workspace opens no tab, so it reveals none (2026-09-30 flood).
    // Mounted hibernated panes get the in-place wake and each decides for itself.
    expect(rec.events).toEqual(['wake:wt-1'])
    expect(rec.mountDetails).toEqual([])
    expect(resumeSpy).toHaveBeenCalledTimes(1)
    const options = resumeSpy.mock.calls[0]?.[1]
    expect(options?.suppressNavigation).toBe(true)
    expect(options?.skipClaimKeys).toBe(rec.wakeDetails[0]?.wokenClaimKeys)
    expect(options?.deferStartupUntilRevealed).toBeUndefined()
  })

  it('starts mid-task agents at once and defers the finished and idle ones', () => {
    storeSettings = {}
    sleepingRecords = { k1: { worktreeId: 'wt-1', paneKey: 'tab-a:leaf-1', tabId: 'tab-a' } }
    wakeSleepingAgentsForWorktreeInBackground('wt-1')
    const defer = resumeSpy.mock.calls[0]?.[1]?.deferStartupUntilRevealedFor
    expect(defer?.(wakeRecord())).toBe(true)
    expect(defer?.(wakeRecord({ origin: 'quit', state: 'working' }))).toBe(false)
    expect(defer?.(wakeRecord({ origin: 'live', state: 'working' }))).toBe(false)
    // A last message that asks keeps its record; the tab's own reveal resumes it (G1 for holds).
    expect(defer?.(wakeRecord({ lastAssistantMessage: 'Want me to open the PR?' }))).toBe(true)
    expect(defer?.(wakeRecord({ origin: 'quit', state: 'done' }))).toBe(true)
    // A manual sleep of an agent that was waiting is the person's own record: not deferred.
    expect(defer?.(wakeRecord({ state: 'waiting' }))).toBe(false)
  })

  it('mounts a passive hibernated tab a guard keeps (a recent touch), never the plain finished ones', () => {
    storeSettings = {}
    const passive = (tab: string, extra: Partial<(typeof sleepingRecords)[string]> = {}) => ({
      worktreeId: 'wt-1',
      paneKey: `${tab}:leaf-1`,
      tabId: tab,
      origin: 'worktree-sleep' as const,
      state: 'done' as const,
      capturedAt: 1,
      providerSession: { key: 'session_id', id: `thread-${tab}` },
      ...extra
    })
    terminalTabsByWorktree = { 'wt-1': [{ id: 'tab-a' }, { id: 'tab-b' }, { id: 'tab-c' }] }
    sleepingRecords = {
      a: passive('tab-a'),
      b: passive('tab-b'),
      c: passive('tab-c', { lastAssistantMessage: 'Which one?\n1. Rebase\n2. Merge' })
    }
    // Sal typed into tab-a five minutes ago (G2); tab-b and tab-c sat idle for an hour.
    lastTerminalInputAtByPaneKey = { 'tab-a:leaf-1': Date.now() - 5 * 60_000 }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    expect(rec.mountDetails).toEqual([{ worktreeId: 'wt-1', tabIds: ['tab-a'] }])
    expect(clearSleepingAgentSessionsByPaneKey).not.toHaveBeenCalled()
  })

  it('51 hibernated agents with numbered summaries and restored ask rows: no tab mounts', () => {
    storeSettings = {}
    const finals = ['Done:\n1. Fixed it\n2. Added tests', 'Open a PR?', 'Pick:\n1. Ship\n2. Wait']
    const tabIds = Array.from({ length: 51 }, (_, index) => `tab-${index}`)
    terminalTabsByWorktree = { 'wt-1': tabIds.map((id) => ({ id })) }
    sleepingRecords = {}
    tabIds.forEach((tabId, index) => {
      const paneKey = `${tabId}:leaf-1`
      const lastAssistantMessage = finals[index % finals.length]
      sleepingRecords[paneKey] = {
        worktreeId: 'wt-1',
        paneKey,
        tabId,
        origin: 'worktree-sleep',
        state: 'done',
        capturedAt: 1,
        providerSession: { key: 'session_id', id: `thread-${index}` },
        lastAssistantMessage
      }
      // Rows main hydrated after a restart (no live hook since) keep each agent's last state,
      // prompt and message: none is a live ask.
      agentStatusByPaneKey[paneKey] = {
        paneKey,
        state: index % 2 === 0 ? 'done' : 'blocked',
        lastAssistantMessage,
        ...(index % 2 === 0
          ? {}
          : { interactivePrompt: 'Allow git push?', restoredUnconfirmed: true })
      }
    })
    isPassiveSpy.mockReturnValue(true)
    const quiet = recordEvents()
    wakeSleepingAgentsForWorktreeInBackground('wt-1')
    quiet.stop()
    expect(quiet.mountDetails).toEqual([])

    // A live hook row waiting on a concrete prompt is the one release: only that tab mounts.
    delete agentStatusByPaneKey['tab-7:leaf-1'].restoredUnconfirmed
    const asking = recordEvents()
    wakeSleepingAgentsForWorktreeInBackground('wt-1')
    asking.stop()
    expect(asking.mountDetails).toEqual([{ worktreeId: 'wt-1', tabIds: ['tab-7'] }])
  })

  it('defers a mid-task agent the person archived (#921): the phone opening its workspace is no reveal', async () => {
    storeSettings = {}
    sleepingRecords = { k1: { worktreeId: 'wt-1', paneKey: 'tab-a:leaf-1', tabId: 'tab-a' } }
    const { setPutAwayPaneReader } = await import('./restore-flood-resume-verdict')
    const unregister = setPutAwayPaneReader((paneKey) => paneKey === 'tab-archived:leaf-1')
    try {
      wakeSleepingAgentsForWorktreeInBackground('wt-1')
      const defer = resumeSpy.mock.calls[0]?.[1]?.deferStartupUntilRevealedFor
      expect(
        defer?.(
          wakeRecord({
            origin: 'quit',
            state: 'working',
            paneKey: 'tab-archived:leaf-1',
            tabId: 'tab-archived'
          })
        )
      ).toBe(true)
      expect(defer?.(wakeRecord({ origin: 'quit', state: 'working' }))).toBe(false)
    } finally {
      unregister()
    }
  })

  it('51 agents automatic sleep put down: all pre-claimed, none mounted, even a touched one', () => {
    // #928's lazy shape under #927: the phone opening the workspace reveals no tab, so neither the
    // mounted panes' armed wakes nor the sweep resume them — not even one a guard would keep (G2).
    storeSettings = {}
    const tabIds = Array.from({ length: 51 }, (_, index) => `tab-${index}`)
    terminalTabsByWorktree = { 'wt-1': tabIds.map((id) => ({ id })) }
    sleepingRecords = {}
    tabIds.forEach((tabId, index) => {
      sleepingRecords[`${tabId}:leaf-1`] = {
        worktreeId: 'wt-1',
        paneKey: `${tabId}:leaf-1`,
        tabId,
        origin: 'worktree-sleep',
        state: 'done',
        capturedAt: 1,
        providerSession: { key: 'session_id', id: `thread-${index}` },
        restoreOnTabOpenOnly: true,
        resumeOnFirstReveal: true
      }
    })
    lastTerminalInputAtByPaneKey = { 'tab-3:leaf-1': Date.now() - 5 * 60_000 }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    expect(rec.events).toEqual(['wake:wt-1'])
    expect(rec.wakeDetails[0]?.wokenClaimKeys?.size).toBe(51)
    expect(rec.mountDetails).toEqual([])
    const options = resumeSpy.mock.calls[0]?.[1]
    expect(options?.skipClaimKeys?.size).toBe(51)
    expect(Object.keys(sleepingRecords)).toHaveLength(51)
  })

  it('mounts a tab the sweep started at once, never one it deferred', () => {
    storeSettings = {}
    sleepingRecords = { k1: { worktreeId: 'wt-1', paneKey: 'tab-a:leaf-1', tabId: 'tab-a' } }
    const rec = recordEvents()
    wakeSleepingAgentsForWorktreeInBackground('wt-1')
    const launched = resumeSpy.mock.calls[0]?.[1]?.onSessionLaunched
    pendingStartupByTabId = { 'tab-deferred': { deferUntilRevealed: true }, 'tab-now': {} }
    launched?.('tab-deferred')
    launched?.('tab-now')
    rec.stop()
    expect(rec.mountDetails).toEqual([{ worktreeId: 'wt-1', tabIds: ['tab-now'] }])
  })
})
