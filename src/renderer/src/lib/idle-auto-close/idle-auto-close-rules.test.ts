import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { PtyListedSession } from '../../../../shared/pty-listed-session'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-terminal-contracts'
import { planHiddenBrowserDiscards } from './idle-auto-close-rules'
import { planIdleShellWorkspaces, type BareShellInputs } from './idle-auto-close-bare-shell-rule'
import type { ProcessInspection } from './idle-auto-close-decision'

const MIN = 60_000
const WINDOW = 30 * MIN
const T0 = 1_000_000_000
const LEAF = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const PANE = `tab-1:${LEAF}`

function tab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'zsh',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function layout(
  ptyIdsByLeafId: Record<string, string> = { [LEAF]: 'pty-1' }
): TerminalLayoutSnapshot {
  const leaves = Object.keys(ptyIdsByLeafId)
  return {
    root:
      leaves.length === 1
        ? { type: 'leaf', leafId: leaves[0]! }
        : {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: leaves[0]! },
            second: { type: 'leaf', leafId: leaves[1]! }
          },
    activeLeafId: leaves[0]!,
    expandedLeafId: null,
    ptyIdsByLeafId
  }
}

function session(id: string, overrides: Partial<PtyListedSession> = {}): PtyListedSession {
  return { id, cwd: '/tmp', title: 'zsh', agentOwnership: 'absent', ...overrides }
}

function terminal(
  ptyId: string,
  overrides: Partial<RuntimeTerminalSummary> = {}
): RuntimeTerminalSummary {
  return {
    handle: `h-${ptyId}`,
    ptyId,
    worktreeId: 'wt-1',
    worktreePath: '/tmp',
    branch: 'main',
    tabId: 'tab-1',
    leafId: LEAF,
    title: 'zsh',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    ...overrides
  }
}

const SHELL: ProcessInspection = { foregroundProcess: 'zsh', hasChildProcesses: false }

function inputs(overrides: Partial<BareShellInputs> = {}): BareShellInputs {
  return {
    now: T0 + WINDOW,
    idleMs: WINDOW,
    activeWorktreeId: 'wt-active',
    tabsByWorktree: { 'wt-1': [tab()] },
    terminalLayoutsByTabId: { 'tab-1': layout() },
    nonLocalWorktreeIds: new Set(),
    isOnScreen: () => false,
    foregroundLastSeenAtByTabId: {},
    lastHumanTouchAt: () => 0,
    isInterruptedRestorePane: () => false,
    isPinned: () => false,
    kept: { paneKeys: new Set(), tabIds: new Set() },
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    heldAgentThisSession: () => false,
    holdsAgentState: () => false,
    launchingTabIds: new Set(),
    lastInputAtByPaneKey: {},
    daemonSessionsById: new Map([['pty-1', session('pty-1')]]),
    runtimeTerminalsByPtyId: new Map([['pty-1', terminal('pty-1', { lastOutputAt: T0 })]]),
    firstObservedAtByPtyId: new Map([['pty-1', T0 - WINDOW]]),
    processByPtyId: new Map([['pty-1', SHELL]]),
    ...overrides
  }
}

function r2(overrides: Partial<BareShellInputs> = {}): { verdict: string; reason: string } {
  const [decision] = planIdleShellWorkspaces(inputs(overrides)).decisions
  return { verdict: decision!.verdict, reason: decision!.reason }
}

describe('R2 idle shell workspace', () => {
  it('keeps an idle shell workspace at 29:59 and puts it to sleep at 30:00', () => {
    expect(r2({ now: T0 + WINDOW - 1 })).toEqual({ verdict: 'skip', reason: 'idle-too-short' })
    expect(r2({ now: T0 + WINDOW })).toEqual({ verdict: 'act', reason: 'idle' })
  })

  it('waits a full window from first observation for a restored PTY with no output time', () => {
    const restored = {
      runtimeTerminalsByPtyId: new Map([['pty-1', terminal('pty-1', { lastOutputAt: null })]]),
      firstObservedAtByPtyId: new Map([['pty-1', T0]])
    }
    expect(r2({ ...restored, now: T0 + WINDOW - 1 }).verdict).toBe('skip')
    expect(r2({ ...restored, now: T0 + WINDOW }).verdict).toBe('act')
  })

  it('asks for a process inspection only for shells past the cheap checks', () => {
    const plan = planIdleShellWorkspaces(inputs({ processByPtyId: new Map() }))
    expect(plan.inspect).toEqual(['pty-1'])
    expect(plan.decisions[0]).toMatchObject({ verdict: 'skip', reason: 'inspect-pending' })
    const pinned = planIdleShellWorkspaces(
      inputs({ processByPtyId: new Map(), isPinned: () => true })
    )
    expect(pinned.inspect).toEqual([])
    const notYetIdle = planIdleShellWorkspaces(
      inputs({ processByPtyId: new Map(), now: T0 + WINDOW - 1 })
    )
    expect(notYetIdle.inspect).toEqual([])
  })

  it.each<[string, Partial<BareShellInputs>, string]>([
    ['its tab on screen (G3)', { isOnScreen: (tabId) => tabId === 'tab-1' }, 'visible'],
    [
      'a person’s touch 9 minutes ago (G2)',
      { lastHumanTouchAt: () => T0 + 21 * MIN },
      'recent-touch'
    ],
    [
      'a mid-task restore record (G5)',
      { isInterruptedRestorePane: () => true },
      'interrupted-restore'
    ],
    ['pinned tab or workspace', { isPinned: () => true }, 'pinned'],
    [
      'saved conversation',
      { kept: { paneKeys: new Set([PANE]), tabIds: new Set() } },
      'saved'
    ],
    ['unknown saved/pinned state', { kept: null }, 'keep-unknown'],
    ['agent status row', { agentStatusByPaneKey: { [PANE]: { state: 'done' } } }, 'agent-pane'],
    ['sleeping record', { sleepingAgentSessionsByPaneKey: { [PANE]: {} } }, 'agent-pane'],
    [
      'an agent earlier this session (its transcript)',
      { heldAgentThisSession: (paneKey) => paneKey === PANE },
      'agent-history'
    ],
    ['the workspace on screen', { activeWorktreeId: 'wt-1' }, 'active-workspace'],
    ['agent state elsewhere in the workspace', { holdsAgentState: () => true }, 'agent-state'],
    ['pending startup', { launchingTabIds: new Set(['tab-1']) }, 'launching'],
    [
      'a child process',
      {
        processByPtyId: new Map([['pty-1', { foregroundProcess: 'vim', hasChildProcesses: true }]])
      },
      'has-children'
    ],
    [
      'an inspection that failed (unknown)',
      {
        processByPtyId: new Map([
          [
            'pty-1',
            { foregroundProcess: null, hasChildProcesses: false, unavailable: true as const }
          ]
        ])
      },
      'process-unknown'
    ],
    ['a remote, SSH or runtime workspace', { nonLocalWorktreeIds: new Set(['wt-1']) }, 'not-local'],
    [
      'an SSH PTY id',
      {
        terminalLayoutsByTabId: { 'tab-1': layout({ [LEAF]: 'ssh:host@@pty-1' }) }
      },
      'not-local'
    ],
    [
      'an agent-owned PTY',
      { daemonSessionsById: new Map([['pty-1', session('pty-1', { agentOwnership: 'present' })]]) },
      'agent-owned'
    ],
    [
      'unknown PTY ownership',
      { daemonSessionsById: new Map([['pty-1', session('pty-1', { agentOwnership: 'unknown' })]]) },
      'owner-unknown'
    ],
    ['a PTY the daemon no longer lists', { daemonSessionsById: new Map() }, 'pty-not-live'],
    ['runtime terminals unreadable', { runtimeTerminalsByPtyId: null }, 'runtime-unavailable'],
    [
      'an agent identity on the runtime terminal',
      {
        runtimeTerminalsByPtyId: new Map([
          ['pty-1', terminal('pty-1', { lastOutputAt: T0, agentIdentity: 'claude' })]
        ])
      },
      'agent-pane'
    ]
  ])('keeps a shell with %s', (_label, overrides, reason) => {
    expect(r2(overrides)).toEqual({ verdict: 'skip', reason })
  })

  it('keeps a split tab when one leaf is not a bare shell', () => {
    const split = {
      terminalLayoutsByTabId: { 'tab-1': layout({ [LEAF]: 'pty-1', [LEAF_2]: 'pty-2' }) },
      daemonSessionsById: new Map([
        ['pty-1', session('pty-1')],
        ['pty-2', session('pty-2')]
      ]),
      runtimeTerminalsByPtyId: new Map([
        ['pty-1', terminal('pty-1', { lastOutputAt: T0 })],
        ['pty-2', terminal('pty-2', { lastOutputAt: T0 })]
      ]),
      firstObservedAtByPtyId: new Map([
        ['pty-1', T0 - WINDOW],
        ['pty-2', T0 - WINDOW]
      ])
    }
    expect(
      r2({
        ...split,
        processByPtyId: new Map([
          ['pty-1', SHELL],
          ['pty-2', { foregroundProcess: 'node', hasChildProcesses: true }]
        ])
      })
    ).toEqual({ verdict: 'skip', reason: 'has-children' })
    expect(
      r2({
        ...split,
        processByPtyId: new Map([
          ['pty-1', SHELL],
          ['pty-2', SHELL]
        ])
      }).verdict
    ).toBe('act')
  })

  it('restarts the window on input, new output or a foreground visit', () => {
    const at20 = T0 + 20 * MIN
    expect(r2({ lastInputAtByPaneKey: { [PANE]: at20 } }).reason).toBe('idle-too-short')
    expect(
      r2({
        runtimeTerminalsByPtyId: new Map([['pty-1', terminal('pty-1', { lastOutputAt: at20 })]])
      }).reason
    ).toBe('idle-too-short')
    expect(r2({ foregroundLastSeenAtByTabId: { 'tab-1': at20 } }).reason).toBe('idle-too-short')
    expect(r2({ now: at20 + WINDOW, lastInputAtByPaneKey: { [PANE]: at20 } }).verdict).toBe('act')
  })

  it('names every tab, pane and PTY an act re-checks, and says the stop keeps history', () => {
    expect(planIdleShellWorkspaces(inputs()).decisions[0]).toMatchObject({
      verdict: 'act',
      key: 'wt-1',
      shellTabs: [{ tabId: 'tab-1', paneKeys: [PANE], ptyIds: ['pty-1'] }],
      evidence: expect.objectContaining({ keepsHistory: true, tabIds: 'tab-1' })
    })
  })

  describe('a workspace of two tabs', () => {
    const PANE_2 = `tab-2:${LEAF_2}`
    const two = (overrides: Partial<BareShellInputs> = {}): BareShellInputs =>
      inputs({
        tabsByWorktree: { 'wt-1': [tab(), tab({ id: 'tab-2', ptyId: 'pty-2', sortOrder: 1 })] },
        terminalLayoutsByTabId: {
          'tab-1': layout(),
          'tab-2': layout({ [LEAF_2]: 'pty-2' })
        },
        daemonSessionsById: new Map([
          ['pty-1', session('pty-1')],
          ['pty-2', session('pty-2')]
        ]),
        runtimeTerminalsByPtyId: new Map([
          ['pty-1', terminal('pty-1', { lastOutputAt: T0 })],
          ['pty-2', terminal('pty-2', { lastOutputAt: T0, tabId: 'tab-2', leafId: LEAF_2 })]
        ]),
        firstObservedAtByPtyId: new Map([
          ['pty-1', T0 - WINDOW],
          ['pty-2', T0 - WINDOW]
        ]),
        processByPtyId: new Map([
          ['pty-1', SHELL],
          ['pty-2', SHELL]
        ]),
        ...overrides
      })

    it('sleeps it as one target once both tabs are idle shells', () => {
      const [decision] = planIdleShellWorkspaces(two()).decisions
      expect(decision).toMatchObject({ verdict: 'act', key: 'wt-1' })
      expect(decision!.shellTabs?.map((shell) => shell.tabId)).toEqual(['tab-1', 'tab-2'])
    })

    it.each<[string, Partial<BareShellInputs>, string]>([
      [
        'one tab runs a command',
        {
          processByPtyId: new Map([
            ['pty-1', SHELL],
            ['pty-2', { foregroundProcess: 'node', hasChildProcesses: true }]
          ])
        },
        'has-children'
      ],
      [
        'one tab was typed into 20 minutes ago',
        { lastInputAtByPaneKey: { [PANE_2]: T0 + 10 * MIN } },
        'idle-too-short'
      ],
      ['one tab is on screen', { isOnScreen: (tabId) => tabId === 'tab-2' }, 'visible']
    ])('keeps the whole workspace when %s', (_label, overrides, reason) => {
      const plan = planIdleShellWorkspaces(two(overrides))
      expect(plan.decisions).toEqual([expect.objectContaining({ verdict: 'skip', reason })])
    })

    it('asks for no inspection when another tab already keeps the workspace', () => {
      const plan = planIdleShellWorkspaces(
        two({ processByPtyId: new Map(), isPinned: (_worktreeId, tabId) => tabId === 'tab-2' })
      )
      expect(plan.inspect).toEqual([])
    })
  })

  it('changes the signature when the idle start moves, so a stale confirmation cannot act', () => {
    const first = planIdleShellWorkspaces(inputs()).decisions[0]!
    const later = planIdleShellWorkspaces(
      inputs({
        now: T0 + 2 * WINDOW,
        runtimeTerminalsByPtyId: new Map([
          ['pty-1', terminal('pty-1', { lastOutputAt: T0 + WINDOW })]
        ])
      })
    ).decisions[0]!
    expect(first.signature).not.toBe('')
    expect(later.signature).not.toBe(first.signature)
  })
})

describe('R3 hidden browser page', () => {
  const base = {
    now: T0 + WINDOW,
    idleMs: WINDOW,
    activeWorktreeId: 'wt-active',
    holdsLiveGuests: () => true,
    isEvictable: () => true,
    isPlayingAudio: () => false
  }

  it('keeps a workspace hidden 29 minutes and discards at 30', () => {
    const hidden = (since: number) =>
      planHiddenBrowserDiscards({ ...base, hiddenSinceByWorktreeId: new Map([['wt-b', since]]) })[0]
    expect(hidden(T0 + MIN)).toMatchObject({ verdict: 'skip', reason: 'idle-too-short' })
    expect(hidden(T0)).toMatchObject({ verdict: 'act', key: 'wt-b' })
  })

  it.each<[string, Partial<typeof base>, string]>([
    ['the visible workspace (G3)', { activeWorktreeId: 'wt-b' }, 'visible'],
    ['no live page', { holdsLiveGuests: () => false }, 'no-live-page'],
    ['a page driven by automation or a phone', { isEvictable: () => false }, 'page-in-use'],
    ['a page playing music or holding a call', { isPlayingAudio: () => true }, 'page-playing-audio']
  ])('keeps %s', (_label, overrides, reason) => {
    const [decision] = planHiddenBrowserDiscards({
      ...base,
      ...overrides,
      hiddenSinceByWorktreeId: new Map([['wt-b', T0 - WINDOW]])
    })
    expect(decision).toMatchObject({ verdict: 'skip', reason })
  })
})
