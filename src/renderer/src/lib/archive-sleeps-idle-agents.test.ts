import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}), subscribe: () => () => {} } }))
vi.mock('@/store/session-sidebar-view', () => ({
  useSessionSidebarView: { getState: () => ({ loaded: false, archived: [] }) }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type {
  ArchiveSleepHostReading,
  ArchiveSleepVia
} from '../../../shared/archive-sleep-contract'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../shared/constants'
import { isArchiveSleepSwitchedOff } from './archive-sleep-verdict'
import {
  createArchiveSleepController,
  type ArchiveSleepDeps,
  type ArchiveSleepHost
} from './archive-sleeps-idle-agents'
import type { SidebarSession } from './sidebar-sessions'

const LEAF = '11111111-1111-4111-8111-111111111111'
const TAB = 'tab-1'
const PANE = `${TAB}:${LEAF}`
const KEY = 'claude:session-1'
const LOCAL: ArchiveSleepHost = { executionHostId: 'local', runtimeEnvironmentId: null }
const MIN = 60_000
const START = 10_000_000
const NUMBERED =
  'Before I open the PR:\n1. Squash the commits?\n2. Target main-next?\n3. Keep the flag'

function row(overrides: Partial<SidebarSession> = {}): SidebarSession {
  return {
    rowKey: 'row-1',
    sessionKey: KEY,
    worktreeId: 'wt',
    hostId: 'local',
    tabId: TAB,
    paneKey: PANE,
    kind: 'terminal',
    label: 'Fix the build',
    workspaceLabel: 'repo',
    agent: 'Claude Code',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

function status(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: START - 60 * MIN,
    stateStartedAt: START - 60 * MIN,
    paneKey: PANE,
    agentType: 'claude',
    stateHistory: [],
    lastAssistantMessage: 'Build fixed and pushed.',
    ...overrides
  }
}

type HarnessOptions = {
  settings?: Partial<GlobalSettings> & { restoreFloodGuard?: boolean }
  status?: Partial<AgentStatusEntry> | null
  ptyId?: string | null
  session?: Partial<SidebarSession>
  host?: ArchiveSleepHost
  loaded?: boolean
  workspaceSessionReady?: boolean
  record?: Partial<SleepingAgentSessionRecord>
}

function harness(options: HarnessOptions = {}) {
  const ptyId = options.ptyId === undefined ? 'pty-1' : options.ptyId
  let now = START
  let state: Record<string, unknown> = {
    settings: { archiveSleepsIdleAgents: true, restoreFloodGuard: true, ...options.settings },
    workspaceSessionReady: options.workspaceSessionReady ?? true,
    tabsByWorktree: { wt: [{ id: TAB, worktreeId: 'wt' }] },
    terminalLayoutsByTabId: ptyId ? { [TAB]: { ptyIdsByLeafId: { [LEAF]: ptyId } } } : {},
    ptyIdsByTabId: ptyId ? { [TAB]: [ptyId] } : {},
    agentStatusByPaneKey: options.status === null ? {} : { [PANE]: status(options.status ?? {}) },
    sleepingAgentSessionsByPaneKey: options.record
      ? { [PANE]: { paneKey: PANE, ...options.record } }
      : {},
    lastTerminalInputAtByPaneKey: {}
  }
  const view = { loaded: options.loaded ?? true, archived: [] as string[] }
  const touch = {
    foreground: [] as string[],
    lastSeen: {} as Record<string, number>,
    visible: new Set<string>(),
    driven: new Set<string>(),
    released: {} as Record<string, number>
  }
  const timers: { at: number; run: () => void; live: boolean }[] = []
  let panes: SidebarSession[] = [row(options.session)]
  let listener: (() => void) | null = null
  const deps: ArchiveSleepDeps = {
    readProtection: vi.fn(() => null),
    app: () => state as unknown as AppState,
    view: () => view,
    panes: () => panes,
    host: () => options.host ?? LOCAL,
    now: () => now,
    touch: (current, at) => ({
      now: at,
      foregroundTabIds: touch.foreground,
      lastSeenAtByTabId: touch.lastSeen,
      inputAtByPaneKey: current.lastTerminalInputAtByPaneKey,
      isTabVisible: (tabId) => touch.visible.has(tabId),
      isPtyDriven: (id) => touch.driven.has(id),
      ptyDriverReleasedAt: (id) => touch.released[id]
    }),
    readHost: vi.fn(async (): Promise<ArchiveSleepHostReading> => ({ clear: true, state: 'idle' })),
    sleep: vi.fn(async () => ({ ok: true })),
    audit: vi.fn(async () => {}),
    subscribeApp: vi.fn((next: () => void) => {
      listener = next
      return () => {
        listener = null
      }
    }),
    setTimer: vi.fn((run: () => void, ms: number) => {
      const timer = { at: now + ms, run, live: true }
      timers.push(timer)
      return () => {
        timer.live = false
      }
    })
  }
  const controller = createArchiveSleepController(deps)
  const change = (patch: Record<string, unknown>): void => {
    state = { ...state, ...patch }
    listener?.()
  }
  const settle = async (): Promise<void> => {
    await controller.idle()
    await controller.idle()
  }
  return {
    deps,
    controller,
    view,
    touch,
    now: () => now,
    liveTimers: () => timers.filter((timer) => timer.live),
    setPanes: (next: SidebarSession[]) => {
      panes = next
    },
    change,
    setStatus: (patch: Partial<AgentStatusEntry>) =>
      change({ agentStatusByPaneKey: { [PANE]: status(patch) } }),
    typedAt: (at: number) => change({ lastTerminalInputAtByPaneKey: { [PANE]: at } }),
    archive: (via: ArchiveSleepVia = 'person') => {
      view.archived = [...new Set([...view.archived, KEY])]
      controller.onArchiveChange({ keys: [KEY], archived: true, via })
    },
    unarchive: () => {
      view.archived = view.archived.filter((key) => key !== KEY)
      controller.onArchiveChange({ keys: [KEY], archived: false, via: 'person' })
    },
    /** Moves the clock and runs every timer that falls due, in order. */
    advance: async (ms: number) => {
      const until = now + ms
      for (;;) {
        const due = timers
          .filter((timer) => timer.live && timer.at <= until)
          .sort((a, b) => a.at - b.at)[0]
        if (!due) {
          break
        }
        due.live = false
        now = Math.max(now, due.at)
        due.run()
        await settle()
      }
      now = until
    },
    settle,
    subscribed: () => listener !== null
  }
}

describe('a person’s archive sleeps an idle agent at once', () => {
  it('sleeps it exactly once and writes the History line with its evidence', async () => {
    const h = harness()
    let answer!: (value: ArchiveSleepHostReading) => void
    h.deps.readHost = vi.fn(
      () =>
        new Promise<ArchiveSleepHostReading>((resolve) => {
          answer = resolve
        })
    )
    h.archive()
    await vi.waitFor(() => expect(h.deps.readHost).toHaveBeenCalledTimes(1))
    // A second archive of the same row while its check is in flight adds nothing.
    h.archive()
    answer({ clear: true, state: 'idle' })
    await h.settle()
    expect(h.deps.sleep).toHaveBeenCalledTimes(1)
    expect(h.deps.sleep).toHaveBeenCalledWith(expect.objectContaining({ paneKey: PANE }))
    expect(h.deps.audit).toHaveBeenCalledWith({
      sessionKey: KEY,
      paneKey: PANE,
      tabId: TAB,
      title: 'Fix the build',
      via: 'person',
      trigger: 'archive',
      evidence: expect.stringMatching(/^archive: Done since .*archived via person.*host: idle/)
    })
    expect(h.controller.pendingPaneKeys()).toEqual([])
    expect(h.liveTimers()).toEqual([])
    expect(h.subscribed()).toBe(false)
  })

  it('keeps a working agent running and sleeps it when it finishes, re-checking then', async () => {
    const h = harness({ status: { state: 'working', stateStartedAt: START } })
    h.archive()
    await h.settle()
    expect(h.deps.readHost).not.toHaveBeenCalled()
    expect(h.controller.pendingPaneKeys()).toEqual([PANE])
    for (const state of ['blocked', 'waiting'] as const) {
      h.setStatus({ state, stateStartedAt: START + 1 })
      await h.settle()
    }
    expect(h.deps.sleep).not.toHaveBeenCalled()
    h.setStatus({ state: 'done', stateStartedAt: START + 2 })
    await h.settle()
    expect(h.deps.sleep).toHaveBeenCalledTimes(1)
    expect(h.deps.audit).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'done' }))
  })

  it('does not sleep at "done" when the person typed into it moments before', async () => {
    const h = harness({ status: { state: 'working', stateStartedAt: START } })
    h.archive()
    h.typedAt(START - 2 * MIN)
    h.setStatus({ state: 'done', stateStartedAt: START + 1 })
    await h.settle()
    expect(h.deps.sleep).not.toHaveBeenCalled()
    expect(h.controller.pendingPaneKeys()).toEqual([PANE])
  })
})

describe('other archives only arm the 30-minute idle timer', () => {
  it.each<ArchiveSleepVia>([
    'sync',
    'cli',
    'pane',
    'steward',
    'auto-archive',
    'transfer',
    'unknown'
  ])(
    'an archive via %s sleeps nothing now, and sleeps after 30 idle minutes out of view',
    async (via) => {
      const h = harness()
      h.archive(via)
      await h.settle()
      expect(h.deps.readHost).not.toHaveBeenCalled()
      expect(h.deps.sleep).not.toHaveBeenCalled()
      expect(h.liveTimers()).toHaveLength(1)
      await h.advance(29 * MIN)
      expect(h.deps.sleep).not.toHaveBeenCalled()
      await h.advance(2 * MIN)
      expect(h.deps.readHost).toHaveBeenCalledTimes(1)
      expect(h.deps.sleep).toHaveBeenCalledTimes(1)
      expect(h.deps.audit).toHaveBeenCalledWith(
        expect.objectContaining({ via, trigger: 'idle-timer' })
      )
    }
  )

  it('unarchiving before the timer fires cancels it', async () => {
    const h = harness()
    h.archive('sync')
    // A sync batch archived the live audit session and unarchived it 60 s later (30 Sep).
    await h.advance(MIN)
    h.unarchive()
    expect(h.controller.pendingPaneKeys()).toEqual([])
    expect(h.liveTimers()).toEqual([])
    await h.advance(60 * MIN)
    expect(h.deps.sleep).not.toHaveBeenCalled()
  })

  it('counts the 30 minutes from the agent’s finish, its last reveal and its last keystroke', async () => {
    const h = harness({ status: { state: 'working', stateStartedAt: START } })
    h.archive('cli')
    await h.advance(20 * MIN)
    h.setStatus({ state: 'done', stateStartedAt: START + 20 * MIN })
    await h.advance(25 * MIN)
    expect(h.deps.sleep).not.toHaveBeenCalled()
    h.touch.lastSeen[TAB] = h.now()
    await h.advance(29 * MIN)
    expect(h.deps.sleep).not.toHaveBeenCalled()
    await h.advance(2 * MIN)
    expect(h.deps.sleep).toHaveBeenCalledTimes(1)
  })

  it('a person archiving it later sleeps it at once', async () => {
    const h = harness()
    h.archive('sync')
    h.archive('person')
    await h.settle()
    expect(h.deps.sleep).toHaveBeenCalledTimes(1)
    expect(h.deps.audit).toHaveBeenCalledWith(expect.objectContaining({ via: 'person' }))
  })

  it('re-checks every keep when the timer fires and keeps waiting while one holds', async () => {
    const h = harness()
    h.archive('pane')
    await h.advance(20 * MIN)
    h.touch.visible.add(TAB)
    await h.advance(40 * MIN)
    expect(h.deps.readHost).not.toHaveBeenCalled()
    expect(h.deps.sleep).not.toHaveBeenCalled()
    expect(h.liveTimers()).toHaveLength(1)
  })
})

describe('the guards every archive sleep enforces', () => {
  const both = async (
    setup: (h: ReturnType<typeof harness>) => void,
    options: HarnessOptions = {}
  ): Promise<ReturnType<typeof harness>[]> => {
    const person = harness(options)
    setup(person)
    person.archive('person')
    await person.settle()
    const timer = harness(options)
    setup(timer)
    timer.archive('sync')
    await timer.advance(90 * MIN)
    return [person, timer]
  }

  it('G1: never an agent whose last reply lists numbered questions or ends with one', async () => {
    for (const text of [NUMBERED, 'Should I merge it?', 'Which one do you want? **']) {
      for (const h of await both(() => {}, { status: { lastAssistantMessage: text } })) {
        expect(h.deps.readHost).not.toHaveBeenCalled()
        expect(h.deps.sleep).not.toHaveBeenCalled()
      }
    }
  })

  it('G1: never an agent the host reads awaiting-user or waiting-for-yes, though its hook says done', async () => {
    for (const state of ['awaiting-user', 'waiting-for-yes']) {
      const [person, timer] = await both((h) => {
        h.deps.readHost = vi.fn(async () => ({ clear: false, keep: 'open-ask' as const, state }))
      })
      expect(person!.deps.readHost).toHaveBeenCalled()
      expect(timer!.deps.readHost).toHaveBeenCalled()
      expect(person!.deps.sleep).not.toHaveBeenCalled()
      expect(timer!.deps.sleep).not.toHaveBeenCalled()
    }
  })

  it('G1: never an agent whose last reply this window could not read as prose', async () => {
    for (const patch of [
      { lastAssistantMessage: undefined },
      { lastAssistantMessage: '  \n' },
      { lastAssistantMessage: 'exit 0', lastAssistantMessageIsToolOutput: true }
    ]) {
      for (const h of await both(() => {}, { status: patch })) {
        expect(h.deps.readHost).not.toHaveBeenCalled()
        expect(h.deps.sleep).not.toHaveBeenCalled()
        expect(h.controller.pendingPaneKeys()).toEqual([PANE])
      }
    }
  })

  it('G1: never with a question card open', async () => {
    for (const h of await both(() => {}, { status: { interactivePrompt: '{"questions":[]}' } })) {
      expect(h.deps.sleep).not.toHaveBeenCalled()
    }
  })

  it('G2: never within 10 minutes of a keystroke, a reveal or a person attaching', async () => {
    const touches: ((h: ReturnType<typeof harness>) => void)[] = [
      (h) => h.typedAt(h.now() - 9 * MIN),
      (h) => {
        h.touch.lastSeen[TAB] = h.now() - 9 * MIN
      },
      (h) => h.touch.foreground.push(TAB),
      (h) => h.touch.driven.add('pty-1')
    ]
    for (const touch of touches) {
      const person = harness()
      touch(person)
      person.archive('person')
      await person.settle()
      expect(person.deps.sleep).not.toHaveBeenCalled()
    }
    // More than ten minutes after the prompt it was given, it may sleep.
    const later = harness()
    later.typedAt(START - 13 * MIN)
    later.change({
      agentStatusByPaneKey: { [PANE]: status({ stateStartedAt: START - 12 * MIN }) }
    })
    later.archive('person')
    await later.settle()
    expect(later.deps.sleep).toHaveBeenCalledTimes(1)
  })

  it('G2: a person’s archive keeps an agent whose driver seat a person let go of under 10 minutes ago', async () => {
    const recent = harness()
    recent.touch.released['pty-1'] = START - 9 * MIN
    recent.archive('person')
    await recent.settle()
    expect(recent.deps.readHost).not.toHaveBeenCalled()
    expect(recent.deps.sleep).not.toHaveBeenCalled()
    expect(recent.controller.pendingPaneKeys()).toEqual([PANE])

    const older = harness()
    older.touch.released['pty-1'] = START - 11 * MIN
    older.archive('person')
    await older.settle()
    expect(older.deps.sleep).toHaveBeenCalledTimes(1)
  })

  it('G2: the idle timer keeps an agent a person read on the phone until 30 minutes after they let go', async () => {
    const h = harness()
    h.archive('steward')
    await h.advance(20 * MIN)
    // Sal reads it on his phone from T+20 to T+29, typing nothing and revealing no tab.
    h.touch.driven.add('pty-1')
    await h.advance(9 * MIN)
    h.touch.driven.delete('pty-1')
    h.touch.released['pty-1'] = h.now()
    await h.advance(2 * MIN)
    expect(h.deps.readHost).not.toHaveBeenCalled()
    expect(h.deps.sleep).not.toHaveBeenCalled()
    await h.advance(27 * MIN)
    expect(h.deps.sleep).not.toHaveBeenCalled()
    await h.advance(2 * MIN)
    expect(h.deps.sleep).toHaveBeenCalledTimes(1)
    expect(h.deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({ via: 'steward', trigger: 'idle-timer' })
    )
  })

  it('G2: the idle timer never sleeps while a person holds the driver seat', async () => {
    const h = harness()
    h.archive('sync')
    h.touch.driven.add('pty-1')
    await h.advance(90 * MIN)
    expect(h.deps.readHost).not.toHaveBeenCalled()
    expect(h.deps.sleep).not.toHaveBeenCalled()
    expect(h.liveTimers()).toHaveLength(1)
  })

  it('G3: never the visible pane, by the same live reading the exit handler uses', async () => {
    for (const h of await both((harnessed) => harnessed.touch.visible.add(TAB))) {
      expect(h.deps.readHost).not.toHaveBeenCalled()
      expect(h.deps.sleep).not.toHaveBeenCalled()
    }
  })

  it('G4: re-checks right before the sleep, after the host read', async () => {
    const shown = harness()
    shown.deps.readHost = vi.fn(async () => {
      shown.touch.visible.add(TAB)
      return { clear: true }
    })
    shown.archive()
    await shown.settle()
    expect(shown.deps.sleep).not.toHaveBeenCalled()

    const started = harness()
    started.deps.readHost = vi.fn(async () => {
      started.setStatus({ state: 'working', stateStartedAt: START + 1 })
      return { clear: true }
    })
    started.archive()
    await started.settle()
    expect(started.deps.sleep).not.toHaveBeenCalled()
    expect(started.controller.pendingPaneKeys()).toEqual([PANE])
  })

  it('G5: never an agent whose quit or live record holds a mid-task turn', async () => {
    for (const origin of ['quit', 'live'] as const) {
      for (const h of await both(() => {}, { record: { origin, state: 'working' } })) {
        expect(h.deps.sleep).not.toHaveBeenCalled()
      }
    }
  })

  it('never inside the prompt queue’s post-delivery hold, or with anything else pending', async () => {
    for (const h of await both((harnessed) => {
      harnessed.deps.readHost = vi.fn(async () => ({ clear: false, keep: 'pending' as const }))
    })) {
      expect(h.deps.readHost).toHaveBeenCalled()
      expect(h.deps.sleep).not.toHaveBeenCalled()
    }
  })

  it('never with a draft typed after it finished, however long ago', async () => {
    const h = harness({ status: { stateStartedAt: START - 60 * MIN } })
    h.typedAt(START - 30 * MIN)
    h.archive()
    await h.settle()
    expect(h.deps.sleep).not.toHaveBeenCalled()
  })

  it.each([
    ['an interrupted turn', { interrupted: true }],
    ['a failed turn', { failed: true }],
    ['background work', { backgroundTaskCount: 1 }],
    [
      'an unsettled dispatch',
      { orchestration: { taskId: 't', dispatchId: 'd', dispatchStatus: 'dispatched' as const } }
    ]
  ])('never with %s', async (_name, patch) => {
    for (const h of await both(() => {}, { status: patch })) {
      expect(h.deps.sleep).not.toHaveBeenCalled()
    }
  })

  it('keeps the agent when the host cannot answer', async () => {
    const h = harness()
    h.deps.readHost = vi.fn(async () => {
      throw new Error('offline')
    })
    h.archive()
    await h.settle()
    expect(h.deps.sleep).not.toHaveBeenCalled()
    expect(h.controller.pendingPaneKeys()).toEqual([PANE])
  })
})

describe('what archive sleep never touches', () => {
  it.each<[string, HarnessOptions]>([
    ['an SSH row', { session: { hostId: 'ssh:devbox' } }],
    ['an SSH worktree', { host: { executionHostId: 'ssh:devbox', runtimeEnvironmentId: null } }],
    ['a paired runtime', { host: { executionHostId: 'local', runtimeEnvironmentId: 'env-1' } }],
    ['a remote PTY', { ptyId: 'remote:env-1:pty-1' }],
    ['an SSH status row', { status: { connectionId: 'conn-1' } }],
    ['a window attached to a remote runtime', { settings: { activeRuntimeEnvironmentId: 'env' } }],
    ['a structured chat row', { session: { kind: 'structured' } }],
    ['anything with the setting off', { settings: { archiveSleepsIdleAgents: false } }],
    ['anything with restoreFloodGuard off', { settings: { restoreFloodGuard: false } }],
    [
      'anything before restoreFloodGuard is installed',
      { settings: { restoreFloodGuard: undefined } }
    ]
  ])('%s', async (_name, options) => {
    const h = harness(options)
    h.archive('person')
    await h.settle()
    h.archive('sync')
    await h.advance(90 * MIN)
    expect(h.controller.pendingPaneKeys()).toEqual([])
    expect(h.liveTimers()).toEqual([])
    expect(h.deps.readHost).not.toHaveBeenCalled()
    expect(h.deps.sleep).not.toHaveBeenCalled()
  })

  it('turning the setting or the flood guard off forgets armed agents and their timers', async () => {
    for (const settings of [{ archiveSleepsIdleAgents: false }, { restoreFloodGuard: false }]) {
      const h = harness({ status: { state: 'working' } })
      h.archive('sync')
      expect(h.controller.pendingPaneKeys()).toEqual([PANE])
      h.change({
        settings: { archiveSleepsIdleAgents: true, restoreFloodGuard: true, ...settings }
      })
      expect(h.controller.pendingPaneKeys()).toEqual([])
      expect(h.liveTimers()).toEqual([])
      expect(h.subscribed()).toBe(false)
    }
  })

  it('ignores archives before the list and the workspace are restored', async () => {
    for (const options of [{ loaded: false }, { workspaceSessionReady: false }]) {
      const h = harness(options)
      h.archive()
      await h.settle()
      expect(h.controller.pendingPaneKeys()).toEqual([])
      expect(h.deps.sleep).not.toHaveBeenCalled()
    }
  })

  it('forgets a pane whose agent is gone, and stops listening once disposed', async () => {
    const gone = harness({ status: { state: 'working' } })
    gone.archive('sync')
    gone.change({ agentStatusByPaneKey: {}, ptyIdsByTabId: {}, terminalLayoutsByTabId: {} })
    expect(gone.controller.pendingPaneKeys()).toEqual([])
    expect(gone.liveTimers()).toEqual([])

    const h = harness({ status: { state: 'working' } })
    h.archive('sync')
    h.controller.dispose()
    expect(h.subscribed()).toBe(false)
    expect(h.liveTimers()).toEqual([])
    h.archive()
    await h.settle()
    expect(h.controller.pendingPaneKeys()).toEqual([])
  })

  it('keeps waiting after a refused sleep', async () => {
    const h = harness()
    h.deps.sleep = vi.fn(async () => ({ ok: false, message: 'not resumable yet' }))
    h.archive()
    await h.settle()
    expect(h.deps.sleep).toHaveBeenCalledTimes(1)
    expect(h.deps.audit).not.toHaveBeenCalled()
    expect(h.controller.pendingPaneKeys()).toEqual([PANE])
  })

  it('judges each pane of a conversation resumed twice on its own, one at a time', async () => {
    const other = '22222222-2222-4222-8222-222222222222'
    const h = harness()
    const second = `${TAB}:${other}`
    h.setPanes([row(), row({ rowKey: 'row-2', paneKey: second })])
    h.change({
      terminalLayoutsByTabId: { [TAB]: { ptyIdsByLeafId: { [LEAF]: 'pty-1', [other]: 'pty-2' } } },
      ptyIdsByTabId: { [TAB]: ['pty-1', 'pty-2'] },
      agentStatusByPaneKey: { [PANE]: status(), [second]: status({ paneKey: second }) }
    })
    h.archive()
    await h.settle()
    expect(vi.mocked(h.deps.sleep).mock.calls.map(([session]) => session.paneKey)).toEqual([
      PANE,
      second
    ])
  })
})

describe('with the app defaults the restore flood guard is on, and every guard still holds', () => {
  // #927 installed the guard (default true in every loaded profile), so archive sleep is live.
  const DEFAULTS = getDefaultSettings('/Users/maintainer')
  const withDefaults = (options: HarnessOptions = {}): ReturnType<typeof harness> => {
    const h = harness(options)
    // Exactly the defaults: nothing this harness adds on its own.
    h.change({ settings: DEFAULTS })
    return h
  }

  it('keeps the defaults until explicit protection is configured', async () => {
    expect(DEFAULTS.restoreFloodGuard).toBe(true)
    expect(DEFAULTS.archiveSleepsIdleAgents).toBe(true)
    expect(isArchiveSleepSwitchedOff({ settings: DEFAULTS })).toBe(false)
    const h = withDefaults()
    h.deps.readProtection = () => 'protection-unconfigured'
    h.archive()
    await h.settle()
    expect(h.deps.sleep).not.toHaveBeenCalled()
  })

  it('G1-G4 keep the agent under the defaults too', async () => {
    const g1 = withDefaults({ status: { lastAssistantMessage: NUMBERED } })
    const g2 = withDefaults()
    g2.typedAt(START - 9 * MIN)
    const g3 = withDefaults()
    g3.touch.visible.add(TAB)
    const g4 = withDefaults()
    g4.deps.readHost = vi.fn(async () => {
      g4.touch.visible.add(TAB)
      return { clear: true }
    })
    for (const h of [g1, g2, g3, g4]) {
      h.archive()
      await h.settle()
      expect(h.deps.sleep).not.toHaveBeenCalled()
    }
    // G4: the keep was re-read after main's answer, right before the sleep.
    expect(g4.deps.readHost).toHaveBeenCalledTimes(1)
  })
})

describe('archive sleep respects automatic cleanup protection', () => {
  it('keeps an exempt project even when a person archives it', async () => {
    const h = harness()
    h.deps.readProtection = vi.fn(() => 'protected-workspace' as const)
    h.archive()
    expect(h.deps.readProtection).toHaveBeenCalledOnce()
    await h.settle()
    expect(h.deps.readProtection).toHaveBeenCalledOnce()
    expect(h.deps.sleep).not.toHaveBeenCalled()
    expect(h.deps.readHost).not.toHaveBeenCalled()
  })

  it('rechecks protection after the asynchronous owner read', async () => {
    const h = harness()
    h.deps.readHost = vi.fn(async () => {
      h.deps.readProtection = () => 'routine'
      return { clear: true }
    })
    h.archive()
    await h.settle()
    expect(h.deps.readHost).toHaveBeenCalledOnce()
    expect(h.deps.sleep).not.toHaveBeenCalled()
  })
})
