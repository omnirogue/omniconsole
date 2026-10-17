// `reports/handoff-diagnosis.md` D3: the 30-minute freshness bound is about how long a NON-terminal
// hook row may be believed without a ping. It was also applied to `done`, and an idle agent emits
// nothing further — so half an hour after a turn ended the pane read as having no row at all, and
// a run committed on it waited for a turn ending that had already happened.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusIpcPayload
} from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import * as processTable from '../../shared/process-table-snapshot'
import * as posix from '../pty/posix-pty-foreground-group'
import { OrcaRuntimeService } from './omni-runtime'
import { createRuntimeAutomationRunTerminalObserver } from '../automations/runtime-terminal-run-observer'
import type { AutomationRun } from '../../shared/automations-types'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'wt-1'
const PTY_ID = 'pty-1'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const NOW = 1_800_000_000_000
const LONG_AGO = NOW - AGENT_STATUS_STALE_AFTER_MS - 15 * 60_000

afterEach(() => {
  vi.restoreAllMocks()
})

function row(
  state: AgentStatusIpcPayload['state'],
  receivedAt: number,
  extra: Partial<AgentStatusIpcPayload> = {}
): AgentStatusIpcPayload {
  return {
    state,
    prompt: 'Write the report',
    agentType: 'claude',
    lastAssistantMessage: 'The report is written.',
    paneKey: PANE_KEY,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    connectionId: null,
    receivedAt,
    stateStartedAt: receivedAt,
    ...extra
  } as AgentStatusIpcPayload
}

async function pane(rows: AgentStatusIpcPayload[]) {
  const hookPid = vi.fn<() => number | undefined>(() => undefined)
  const runtime = new OrcaRuntimeService(null, undefined, {
    getAgentStatusSnapshot: () => rows,
    getAgentProviderSessionRowsForPane: (paneKey) => rows.filter((row) => row.paneKey === paneKey),
    getAgentHookPidForPane: hookPid
  })
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
    ptysById: Map<string, { launchToken: string | null; incarnationId: string | null }>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID, incarnationId: 'inc-1' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'claude'
  })
  const terminal = await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    title: 'Terminal'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle: 'Terminal'
      }
    ]
  })
  // The one clock the freshness bound is read from, fixed after the pane exists.
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  return {
    runtime,
    terminal,
    internals,
    hookPid,
    read: () => runtime.getFreshAgentHookStatusForHandle(terminal.handle),
    readAsk: () => runtime.getFreshAgentHookStatusForHandle(terminal.handle, { openAsk: true }),
    launchedWith: (token: string) => {
      internals.ptysById.get(PTY_ID)!.launchToken = token
    }
  }
}

describe('a terminal `done` row on a PTY that is still attached', () => {
  it('stays true past the freshness window: an idle agent has nothing more to report', async () => {
    const p = await pane([row('done', LONG_AGO)])
    expect(p.read()).toMatchObject({
      state: 'done',
      stateStartedAt: LONG_AGO,
      updatedAt: LONG_AGO,
      lastAssistantMessage: 'The report is written.'
    })
  })

  it('counts after a restart too: a hydrated `done` row of a pane whose PTY re-attached', async () => {
    // Hydration never marks a `done` row unconfirmed, and it carries no launch token: the pane key
    // is all that ties it to the PTY, which a fresh host record knows no token for either.
    const p = await pane([row('done', LONG_AGO, { restoredUnconfirmed: undefined })])
    expect(p.read()).toMatchObject({ state: 'done', stateStartedAt: LONG_AGO })
  })

  it('recovers through the real getter when retaining the native row produced an equal cache timestamp', async () => {
    const observation: AgentStatusIpcPayload['observation'] = {
      origin: 'hook',
      kind: 'transition',
      authorityId: 'owner-after-restart',
      incarnation: 1,
      revision: 2,
      observedAt: NOW
    }
    const p = await pane([
      row('done', NOW, {
        launchToken: 'current-launch',
        observation,
        providerSessionOnly: false,
        providerSession: { key: 'session_id', id: 'current-provider' }
      })
    ])
    p.launchedWith('current-launch')
    const internals = p.runtime as unknown as {
      retainAgentRowSnapshot: (...args: unknown[]) => void
    }
    internals.retainAgentRowSnapshot(PTY_ID, PANE_KEY, WORKTREE_ID, TAB_ID, null, {
      state: 'done',
      agentType: 'claude',
      lastAssistantMessage: 'Cached payload'
    })
    expect(p.read()).toMatchObject({
      observation,
      onAttachedPty: true,
      providerSessionOnly: false,
      providerSession: { key: 'session_id', id: 'current-provider' },
      lastAssistantMessage: 'The report is written.'
    })
    const run: AutomationRun = {
      id: 'run',
      automationId: 'routine',
      title: 'Report',
      scheduledFor: NOW - 1_000,
      status: 'dispatched',
      trigger: 'scheduled',
      workspaceId: WORKTREE_ID,
      sessionKind: 'terminal',
      chatSessionId: null,
      terminalSessionId: TAB_ID,
      terminalPaneKey: PANE_KEY,
      terminalPtyId: PTY_ID,
      outputSnapshot: null,
      precheckResult: null,
      usage: null,
      error: null,
      startedAt: NOW - 1_000,
      dispatchedAt: NOW - 1_000,
      createdAt: NOW - 1_000,
      providerSessionId: 'current-provider',
      providerSessionAgent: 'claude',
      terminalProcessIncarnation: `${PTY_ID}:inc-1`
    }
    const observer = createRuntimeAutomationRunTerminalObserver({
      getTerminalHandleForPaneKey: (key) => p.runtime.getTerminalHandleForPaneKey(key),
      getFreshAgentHookStatusForHandle: (handle) =>
        p.runtime.getFreshAgentHookStatusForHandle(handle),
      getTerminalProcessIncarnation: (handle) => p.runtime.getTerminalProcessIncarnation(handle),
      showTerminal: async () => ({ ptyId: PTY_ID }),
      readTerminal: async () => ({ tail: ['The current report.'] }),
      getTerminalAgentStatus: async () => ({ isRunningAgent: true, status: 'idle' }),
      waitForTerminal: async () => ({ satisfied: true })
    })
    expect(
      await observer.observeCompletion(p.terminal.handle, {
        signal: new AbortController().signal,
        readCurrentRun: () => run
      })
    ).toMatchObject({ status: 'completed', outputSnapshot: { content: 'The current report.' } })
  })

  it('does not grant attached native provenance to a replaced launch token', async () => {
    const p = await pane([
      row('done', NOW, {
        launchToken: 'old-launch',
        observation: {
          origin: 'hook',
          kind: 'transition',
          authorityId: 'owner',
          incarnation: 1,
          revision: 1,
          observedAt: NOW
        },
        providerSession: { key: 'session_id', id: 'provider' }
      })
    ])
    p.launchedWith('replacement-launch')
    expect(p.read()).toMatchObject({ state: 'done', onAttachedPty: false })
  })
})

describe('fresh question provider identity', () => {
  const question = JSON.stringify({
    questions: [{ question: 'Choose?', options: ['Red', 'Blue'] }]
  })
  const providerSession = {
    key: 'session_id' as const,
    id: 'current-provider',
    transcriptPath: '/private/transcript'
  }

  it('projects only the live hook provider key/id and agent type', async () => {
    const p = await pane([
      row('waiting', NOW, { interactivePrompt: question, providerSession, agentPid: 200 })
    ])
    expect(p.read()).toMatchObject({
      agentType: 'claude',
      providerSession: { key: 'session_id', id: 'current-provider' },
      agentPid: 200
    })
    expect(p.read()?.providerSession).not.toHaveProperty('transcriptPath')
  })

  it.each([
    'same-text-same-state-start',
    'different-question',
    'restored',
    'old',
    'missing-pid',
    'new-occurrence',
    'missing-launch',
    'different-launch'
  ])('never borrows HTTP provider identity for a retained OSC row: %s', async (variant) => {
    const live = row('waiting', variant === 'old' ? LONG_AGO : NOW - 1, {
      interactivePrompt: variant === 'different-question' ? 'another question' : question,
      providerSession,
      agentPid: variant === 'missing-pid' ? undefined : 200,
      stateStartedAt: variant === 'new-occurrence' ? NOW - 200 : NOW - 100,
      launchToken:
        variant === 'missing-launch'
          ? undefined
          : variant === 'different-launch'
            ? 'previous-launch'
            : 'current-launch',
      restoredUnconfirmed: variant === 'restored' ? true : undefined
    })
    const p = await pane([live])
    p.launchedWith('current-launch')
    const internals = p.runtime as unknown as {
      retainAgentRowSnapshot: (...args: unknown[]) => void
    }
    vi.mocked(Date.now).mockReturnValue(NOW - 100)
    const payload = {
      state: 'waiting',
      agentType: 'claude',
      interactivePrompt: question
    }
    internals.retainAgentRowSnapshot(PTY_ID, PANE_KEY, WORKTREE_ID, TAB_ID, null, payload)
    vi.mocked(Date.now).mockReturnValue(NOW)
    internals.retainAgentRowSnapshot(PTY_ID, PANE_KEY, WORKTREE_ID, TAB_ID, null, payload)
    const projected = p.read()
    expect(projected?.stateStartedAt).toBe(NOW - 100)
    expect(projected?.providerSession).toBeUndefined()
    expect(projected?.agentPid).toBeUndefined()
  })
})

async function restoredCodex() {
  const done = row('done', LONG_AGO, {
    agentType: 'codex',
    agentPid: 301,
    lastAssistantMessage: 'ACK',
    providerSession: { key: 'session_id', id: 'restored-codex' }
  })
  const p = await pane([done])
  const processes = [
    { pid: 100, ppid: 1, stat: 'Ss', command: '-zsh' },
    { pid: 300, ppid: 100, stat: 'S+', command: 'node /opt/bin/codex resume restored-codex' },
    {
      pid: 301,
      ppid: 300,
      stat: 'S+',
      command: '/opt/codex/vendor/bin/codex resume restored-codex'
    }
  ]
  const listProcesses = vi.fn(async () => [
    {
      id: PTY_ID,
      incarnationId: 'inc-1',
      rootProcessId: 100,
      title: 'Codex',
      cwd: '/repo/app'
    }
  ])
  const controller = {
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'codex',
    listProcesses
  }
  p.runtime.setPtyController(controller)
  vi.spyOn(processTable, 'getFreshProcessTableSnapshot').mockResolvedValue(processes)
  vi.spyOn(posix, 'readPosixReceiverRow').mockImplementation(async (pid) => ({
    pgid: 300,
    tpgid: 300,
    tty: 'ttys001',
    stat: 'S+',
    command: processes.find((row) => row.pid === pid)!.command,
    startTimeMs: LONG_AGO - (pid === 300 ? 2000 : 1000)
  }))
  vi.spyOn(p.runtime, 'readTerminal').mockResolvedValue({
    handle: p.terminal.handle,
    status: 'running',
    source: 'screen',
    truncated: false,
    nextCursor: null,
    tail: [
      '› Reply with the exact acknowledgement.',
      '• ACK',
      '3:00 PM',
      'Tip: Use /help to see available commands.',
      '› Ask Codex to do anything',
      'gpt-6-astra medium · ~/workspace',
      '? for shortcuts'
    ]
  })
  return { ...p, done, controller, listProcesses }
}

it.skipIf(process.platform === 'win32')(
  're-proves the restored native Codex child for completion without hydrating the live hook binder',
  async () => {
    const p = await restoredCodex()
    expect(await p.runtime.readTerminalProcessEvidence(p.terminal.handle)).toMatchObject({
      proof: { pid: 300, startTimeMs: LONG_AGO - 2000, via: 'command-line' }
    })
    const evidence = await p.runtime.readTerminalAgentEvidence(p.terminal.handle, 'codex')
    expect(evidence.screen).toMatchObject({ readyPrompt: true, turnDone: true })
    expect(evidence.process).toMatchObject({ pid: 300, startTimeMs: LONG_AGO - 2000 })
    expect(posix.readPosixReceiverRow).toHaveBeenCalledWith(301)
    expect(p.hookPid()).toBeUndefined()
  }
)

it.skipIf(process.platform === 'win32')(
  'refuses completion recovery across a PTY incarnation change during its process sample',
  async () => {
    const p = await restoredCodex()
    const listed = await p.listProcesses()
    p.listProcesses.mockImplementation(async () => {
      p.internals.ptysById.get(PTY_ID)!.incarnationId = 'replacement'
      return [{ ...listed[0]!, incarnationId: 'replacement' }]
    })
    expect(
      (await p.runtime.readTerminalAgentEvidence(p.terminal.handle, 'codex')).screen?.readyPrompt
    ).toBe(false)
    expect(posix.readPosixReceiverRow).not.toHaveBeenCalledWith(301)
  }
)

it.skipIf(process.platform === 'win32')(
  'refuses completion recovery across a controller change or a conflicting live hook owner',
  async () => {
    const p = await restoredCodex()
    const listed = await p.listProcesses()
    p.listProcesses.mockImplementation(async () => {
      p.runtime.setPtyController({ ...p.controller })
      return listed
    })
    expect(
      (await p.runtime.readTerminalAgentEvidence(p.terminal.handle, 'codex')).screen?.readyPrompt
    ).toBe(false)
    expect(posix.readPosixReceiverRow).not.toHaveBeenCalledWith(301)

    p.listProcesses.mockResolvedValue(listed)
    p.hookPid.mockReturnValue(300)
    expect(
      (await p.runtime.readTerminalAgentEvidence(p.terminal.handle, 'codex')).screen?.readyPrompt
    ).toBe(false)
    expect(posix.readPosixReceiverRow).not.toHaveBeenCalledWith(301)
  }
)

describe('what the freshness bound still retires', () => {
  it.each(['working', 'waiting', 'blocked'] as const)(
    'an old `%s` row, which may describe a turn that ended unseen',
    async (state) => {
      const p = await pane([row(state, LONG_AGO)])
      expect(p.read()).toBeNull()
    }
  )

  it('a `done` row whose PTY has exited', async () => {
    const p = await pane([row('done', LONG_AGO)])
    p.runtime.onPtyExit(PTY_ID, 0)
    expect(p.read()).toBeNull()
  })

  it('a `done` row reported by the process this pane ran before its current launch', async () => {
    const p = await pane([row('done', LONG_AGO, { launchToken: 'token-of-the-old-process' })])
    p.launchedWith('token-of-this-process')
    expect(p.read()).toBeNull()
  })

  it('an unconfirmed hydrated row, however recent', async () => {
    const p = await pane([row('working', NOW - 1_000, { restoredUnconfirmed: true })])
    expect(p.read()).toBeNull()
  })
})

it('still prefers the newest row: a fresh `working` row outranks the old `done` one', async () => {
  const p = await pane([row('done', LONG_AGO), row('working', NOW - 5_000)])
  expect(p.read()).toMatchObject({ state: 'working', updatedAt: NOW - 5_000 })
})

const ASK_PROMPT = JSON.stringify({
  questions: [
    {
      question: 'Who pushes the backend to production?',
      header: 'Who ships',
      multiSelect: false,
      options: [{ label: 'Uma ships it' }, { label: 'This session ships it' }]
    }
  ]
})

function askRow(receivedAt: number, extra: Partial<AgentStatusIpcPayload> = {}) {
  return row('waiting', receivedAt, {
    toolName: 'AskUserQuestion',
    interactivePrompt: ASK_PROMPT,
    ...extra
  })
}

describe('a question the agent still waits on, read with `openAsk`', () => {
  it('is kept past the freshness window and marked unconfirmed: a waiting agent reports nothing', async () => {
    const p = await pane([askRow(LONG_AGO)])
    expect(p.read()).toBeNull()
    expect(p.readAsk()).toMatchObject({
      state: 'waiting',
      interactivePrompt: ASK_PROMPT,
      onAttachedPty: true,
      unconfirmedAsk: true
    })
  })

  it('is kept, marked, when a restart restored it unconfirmed', async () => {
    const p = await pane([askRow(NOW - 1_000, { restoredUnconfirmed: true })])
    expect(p.read()).toBeNull()
    expect(p.readAsk()).toMatchObject({ interactivePrompt: ASK_PROMPT, unconfirmedAsk: true })
  })

  it('is not marked while its report is fresh', async () => {
    const p = await pane([askRow(NOW - 1_000)])
    expect(p.readAsk()).toMatchObject({ interactivePrompt: ASK_PROMPT })
    expect(p.readAsk()).not.toHaveProperty('unconfirmedAsk')
  })

  it('is dropped once a later report replaced it, however old that report is', async () => {
    const p = await pane([askRow(LONG_AGO - 60_000), row('working', LONG_AGO)])
    expect(p.readAsk()).toBeNull()
  })

  it('is dropped with its PTY, or when the process before this launch asked it', async () => {
    const exited = await pane([askRow(LONG_AGO)])
    exited.runtime.onPtyExit(PTY_ID, 0)
    expect(exited.readAsk()).toBeNull()

    const relaunched = await pane([askRow(LONG_AGO, { launchToken: 'token-of-the-old-process' })])
    relaunched.launchedWith('token-of-this-process')
    expect(relaunched.readAsk()).toBeNull()
  })

  it('keeps no other old row: only a question waits indefinitely', async () => {
    const p = await pane([row('waiting', LONG_AGO)])
    expect(p.readAsk()).toBeNull()
  })
})
