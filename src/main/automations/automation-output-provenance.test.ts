import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { AutomationDispatchResult, AutomationRun } from '../../shared/automations-types'
import type { OrchestrationCompatibilityTerminalAuthority } from '../runtime/omni-runtime'
import type { readAutomationFinalTurn } from './automation-final-turn'
import type { AutomationOutputBinding } from './automation-output-binding'
import {
  createAutomationFinalOutputResolver,
  withoutClaimedAssistantProvenance
} from './automation-output-provenance'

vi.mock('./automation-final-turn', () => ({ readAutomationFinalTurn: vi.fn() }))

const proven = { content: '  Native final answer.\nEvidence: verified.\n', completedAt: 2_500 }
const nativePath = '/fixture/native-transcript.jsonl'
const claimedPath = '/fixture/renderer-claimed-transcript.jsonl'
const launchToken = 'fixture-native-launch'
const readAt = 3_100

function outputBinding(overrides: Partial<AutomationOutputBinding> = {}): AutomationOutputBinding {
  return Object.freeze({
    automationId: 'routine-1',
    runId: 'run-1',
    agent: 'claude',
    workspaceId: 'workspace-1',
    paneKey: 'pane-1',
    terminalHandle: 'terminal-1',
    ptyId: 'pty-1',
    processIncarnation: 'process-1',
    launchTokenHash: createHash('sha256').update(launchToken).digest('hex'),
    startedAt: 1_000,
    ...overrides
  })
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'routine-1',
    status: 'dispatched',
    workspaceId: 'workspace-1',
    terminalPaneKey: 'pane-1',
    startedAt: 1_000,
    dispatchedAt: 900,
    createdAt: 800,
    providerSessionId: 'session-1',
    providerSessionAgent: 'claude',
    providerSessionTranscriptPath: '/fixture/saved-transcript.jsonl',
    ...overrides
  } as AutomationRun
}

function hook(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: 'pane-1',
    worktreeId: 'workspace-1',
    terminalHandle: 'terminal-1',
    launchToken,
    connectionId: null,
    state: 'done',
    prompt: 'Routine prompt',
    agentType: 'claude',
    stateStartedAt: 2_000,
    receivedAt: 3_000,
    providerSession: { key: 'session_id', id: 'session-1', transcriptPath: nativePath },
    observation: {
      origin: 'hook',
      kind: 'transition',
      authorityId: 'main-fixture',
      incarnation: 1,
      revision: 2,
      observedAt: 3_000
    },
    ...overrides
  }
}

function claimedResult(): AutomationDispatchResult {
  return {
    runId: 'run-1',
    status: 'completed',
    providerSession: {
      providerSessionAgent: 'codex',
      providerSessionId: 'renderer-session',
      providerSessionTranscriptPath: claimedPath
    },
    outputSnapshot: {
      format: 'plain_text',
      content: 'Renderer claims PASS',
      capturedAt: 99_999,
      truncated: true,
      provenance: 'assistant_message'
    }
  }
}

function fixture(
  rows: readonly AgentStatusIpcPayload[] = [hook()],
  binding: AutomationOutputBinding | null = outputBinding()
) {
  const readNativeStatus = vi.fn(() => rows)
  const readFinalTurn = vi.fn<typeof readAutomationFinalTurn>().mockReturnValue(proven)
  const readBinding = vi
    .fn<(_: AutomationRun) => AutomationOutputBinding | null>()
    .mockReturnValue(binding)
  const authority: OrchestrationCompatibilityTerminalAuthority | null = binding
    ? {
        runtimeId: 'runtime-1',
        terminalHandle: binding.terminalHandle,
        ptyId: binding.ptyId,
        processIncarnation: binding.processIncarnation,
        paneKey: binding.paneKey,
        launchTokenHash: binding.launchTokenHash,
        worktreeId: binding.workspaceId,
        hostScope: { kind: 'local', hostId: 'local' }
      }
    : null
  const readAuthority = vi
    .fn<(_: string) => OrchestrationCompatibilityTerminalAuthority | null>()
    .mockReturnValue(authority)
  const now = vi.fn(() => readAt)
  const resolve = createAutomationFinalOutputResolver(
    readNativeStatus,
    readFinalTurn,
    readBinding,
    readAuthority,
    now
  )
  return { readNativeStatus, readFinalTurn, readBinding, readAuthority, authority, now, resolve }
}

describe('native automation final output provenance', () => {
  it.each(['claude', 'codex'] as const)(
    'reconstructs exact %s text only from a native bound final turn',
    (agent) => {
      const f = fixture([hook({ agentType: agent })], outputBinding({ agent }))
      const result = claimedResult()
      const original = structuredClone(result)

      expect(f.resolve(run({ providerSessionAgent: agent }), result)).toEqual({
        format: 'plain_text',
        content: proven.content,
        capturedAt: proven.completedAt,
        truncated: false,
        provenance: 'assistant_message'
      })
      expect(f.readAuthority).toHaveBeenCalledTimes(2)
      expect(f.readAuthority).toHaveBeenNthCalledWith(1, 'terminal-1')
      expect(f.readAuthority).toHaveBeenNthCalledWith(2, 'terminal-1')
      expect(f.readNativeStatus).toHaveBeenCalledExactlyOnceWith('pane-1')
      expect(f.readFinalTurn).toHaveBeenCalledExactlyOnceWith({
        agent,
        sessionId: 'session-1',
        transcriptPath: nativePath,
        startedAt: 1_000,
        completedAt: readAt
      })
      expect(JSON.stringify(f.readFinalTurn.mock.calls)).not.toContain(claimedPath)
      expect(JSON.stringify(f.readFinalTurn.mock.calls)).not.toContain('saved-transcript')
      expect(result).toEqual(original)
    }
  )

  it.each([
    ['wrong pane', { paneKey: 'other-pane' }],
    ['wrong workspace', { worktreeId: 'other-workspace' }],
    ['wrong launch token', { launchToken: 'different-native-launch' }],
    ['missing launch token', { launchToken: undefined }],
    ['wrong terminal handle', { terminalHandle: 'different-terminal' }],
    ['remote observation', { connectionId: 'remote-host' }],
    ['working state', { state: 'working' }],
    ['failed turn', { failed: true }],
    ['interrupted turn', { interrupted: true }],
    ['session boundary', { sessionBoundary: true }],
    ['session-only update', { providerSessionOnly: true }],
    ['restored state', { restoredUnconfirmed: true }],
    ['missing observation', { observation: undefined }],
    ['renderer evidence', { observation: { ...hook().observation!, origin: 'osc' } }],
    ['hook snapshot', { observation: { ...hook().observation!, kind: 'snapshot' } }],
    ['identity-only hook', { observation: { ...hook().observation!, kind: 'identity-only' } }],
    ['missing transition kind', { observation: { ...hook().observation!, kind: undefined } }],
    ['transition before run start', { stateStartedAt: 999 }],
    ['receipt before transition', { receivedAt: 1_999 }],
    ['invalid receipt time', { receivedAt: Number.NaN }],
    ['infinite receipt time', { receivedAt: Infinity }],
    ['future receipt time', { receivedAt: readAt + 1 }],
    ['invalid transition time', { stateStartedAt: Number.NaN }],
    ['infinite transition time', { stateStartedAt: Infinity }],
    ['unsupported provider', { agentType: 'gemini' }],
    ['wrong provider', { agentType: 'codex' }],
    ['missing provider session', { providerSession: undefined }],
    [
      'unbound conversation identity',
      { providerSession: { key: 'conversation_id', id: 'session-1', transcriptPath: nativePath } }
    ],
    ['missing native transcript', { providerSession: { key: 'session_id', id: 'session-1' } }]
  ] as [string, Partial<AgentStatusIpcPayload>][])(
    'rejects %s before reading any transcript',
    (_name, overrides) => {
      const f = fixture([hook(overrides)])
      expect(f.resolve(run(), claimedResult())).toBeNull()
      expect(f.readFinalTurn).not.toHaveBeenCalled()
    }
  )

  it.each([null, outputBinding({ startedAt: Number.NaN }), outputBinding({ startedAt: Infinity })])(
    'requires a native binding with a finite start time: %j',
    (binding) => {
      const f = fixture([hook()], binding)
      expect(f.resolve(run(), claimedResult())).toBeNull()
      expect(f.readNativeStatus).not.toHaveBeenCalled()
      expect(f.readFinalTurn).not.toHaveBeenCalled()
    }
  )

  it('fails closed when no native binding reader is installed', () => {
    const f = fixture()
    const resolve = createAutomationFinalOutputResolver(f.readNativeStatus, f.readFinalTurn)
    expect(resolve(run(), claimedResult())).toBeNull()
    expect(f.readNativeStatus).not.toHaveBeenCalled()
    expect(f.readFinalTurn).not.toHaveBeenCalled()
  })

  it('fails closed when no current terminal authority reader is installed', () => {
    const f = fixture()
    const resolve = createAutomationFinalOutputResolver(
      f.readNativeStatus,
      f.readFinalTurn,
      f.readBinding
    )
    expect(resolve(run(), claimedResult())).toBeNull()
    expect(f.readNativeStatus).not.toHaveBeenCalled()
    expect(f.readFinalTurn).not.toHaveBeenCalled()
  })

  it('does not trust a retained hook after the terminal authority disappears', () => {
    const f = fixture()
    f.readAuthority.mockReturnValue(null)
    expect(f.resolve(run(), claimedResult())).toBeNull()
    expect(f.readAuthority).toHaveBeenCalledExactlyOnceWith('terminal-1')
    expect(f.readNativeStatus).not.toHaveBeenCalled()
    expect(f.readFinalTurn).not.toHaveBeenCalled()
  })

  it.each([
    ['replacement PTY with the same pane and launch token', { ptyId: 'replacement-pty' }],
    [
      'replacement process with the same pane and launch token',
      { processIncarnation: 'replacement-process' }
    ],
    ['different pane', { paneKey: 'other-pane' }],
    ['different terminal handle', { terminalHandle: 'other-terminal' }],
    ['different workspace', { worktreeId: 'other-workspace' }],
    ['different native launch hash', { launchTokenHash: 'different-hash' }],
    ['missing process incarnation', { processIncarnation: null }],
    ['SSH host scope', { hostScope: { kind: 'ssh', targetId: 'remote-host' } }],
    ['WSL host scope', { hostScope: { kind: 'wsl', hostId: 'local', distro: 'Ubuntu' } }]
  ] satisfies [string, Partial<OrchestrationCompatibilityTerminalAuthority>][])(
    'rejects proof from a current authority with %s',
    (_label, overrides) => {
      const f = fixture()
      f.readAuthority.mockReturnValue({ ...f.authority!, ...overrides })
      expect(f.resolve(run(), claimedResult())).toBeNull()
      expect(f.readAuthority).toHaveBeenCalledExactlyOnceWith('terminal-1')
      expect(f.readNativeStatus).not.toHaveBeenCalled()
      expect(f.readFinalTurn).not.toHaveBeenCalled()
    }
  )

  it.each([{ id: 'another-run' }, { automationId: 'another-routine' }])(
    'refuses a binding whose immutable lookup identity does not match the requested run: %j',
    (overrides) => {
      const f = fixture()
      expect(f.resolve(run(overrides), claimedResult())).toBeNull()
      expect(f.readNativeStatus).not.toHaveBeenCalled()
      expect(f.readFinalTurn).not.toHaveBeenCalled()
    }
  )

  it.each([
    { terminalPaneKey: 'attacker-pane', workspaceId: 'attacker-workspace' },
    { terminalPaneKey: null, workspaceId: null },
    { startedAt: 1, dispatchedAt: 2, createdAt: 3 },
    { startedAt: null, dispatchedAt: null, createdAt: Number.NaN },
    {
      providerSessionId: 'attacker-session',
      providerSessionAgent: 'codex',
      providerSessionTranscriptPath: claimedPath
    }
  ] as Partial<AutomationRun>[])(
    'ignores mutable saved run metadata when choosing native proof: %j',
    (overrides) => {
      const f = fixture()
      const current = run(overrides)
      expect(f.resolve(current, claimedResult())).toMatchObject({ content: proven.content })
      expect(f.readBinding).toHaveBeenCalledExactlyOnceWith(current)
      expect(f.readNativeStatus).toHaveBeenCalledExactlyOnceWith('pane-1')
      expect(f.readFinalTurn).toHaveBeenCalledExactlyOnceWith({
        agent: 'claude',
        sessionId: 'session-1',
        transcriptPath: nativePath,
        startedAt: 1_000,
        completedAt: readAt
      })
    }
  )

  it('accepts a token-bound native hook without optional terminal-handle metadata', () => {
    const f = fixture([hook({ terminalHandle: undefined })])
    expect(f.resolve(run(), claimedResult())).toMatchObject({ content: proven.content })
  })

  it('uses a native provider session even when the saved session ID names an earlier session', () => {
    const f = fixture()
    expect(f.resolve(run({ providerSessionId: 'earlier-session' }), claimedResult())).not.toBeNull()
    expect(f.readFinalTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' })
    )
  })

  it('does not promote saved or renderer paths when the native observation is missing', () => {
    const f = fixture([])
    expect(f.resolve(run(), claimedResult())).toBeNull()
    expect(f.readFinalTurn).not.toHaveBeenCalled()
  })

  it('leaves output unproven when the native parser rejects its transcript', () => {
    const f = fixture()
    f.readFinalTurn.mockReturnValue(null)
    expect(f.resolve(run(), claimedResult())).toBeNull()
    expect(f.readFinalTurn).toHaveBeenCalledTimes(1)
  })

  it.each([Number.NaN, Infinity, 2_999])(
    'rejects an invalid host read time or future Stop receipt: %s',
    (time) => {
      const f = fixture()
      f.now.mockReturnValue(time)
      expect(f.resolve(run(), claimedResult())).toBeNull()
      expect(f.readFinalTurn).not.toHaveBeenCalled()
    }
  )

  it.each([Number.NaN, Infinity, 999, readAt + 1])(
    'rejects native proof outside the finite bound-start/host-read interval: %s',
    (completedAt) => {
      const f = fixture()
      f.readFinalTurn.mockReturnValue({ ...proven, completedAt })
      expect(f.resolve(run(), claimedResult())).toBeNull()
    }
  )

  it('captures one host-time cutoff without extending it during the transcript read', () => {
    const f = fixture()
    f.readFinalTurn.mockImplementation((locator) => {
      f.now.mockReturnValue(readAt + 10_000)
      expect(locator.completedAt).toBe(readAt)
      return { ...proven, completedAt: readAt + 1 }
    })
    expect(f.resolve(run(), claimedResult())).toBeNull()
    expect(f.now).toHaveBeenCalledOnce()
  })

  it('selects only the matching native observation when other panes or workspaces appear first', () => {
    const f = fixture([
      hook({ paneKey: 'other-pane' }),
      hook({ worktreeId: 'other-workspace' }),
      hook()
    ])
    expect(f.resolve(run(), claimedResult())).toMatchObject({ content: proven.content })
    expect(f.readFinalTurn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        transcriptPath: nativePath,
        sessionId: 'session-1'
      })
    )
  })

  it('captures the native locator before hook or run objects can change during parsing', () => {
    const row = hook()
    const current = run()
    const f = fixture([row])
    f.readFinalTurn.mockImplementation((locator) => {
      row.providerSession!.id = 'later-session'
      row.providerSession!.transcriptPath = '/fixture/later-transcript.jsonl'
      row.agentType = 'codex'
      row.receivedAt = 9_000
      current.startedAt = 8_000
      expect(locator).toEqual({
        agent: 'claude',
        sessionId: 'session-1',
        transcriptPath: nativePath,
        startedAt: 1_000,
        completedAt: readAt
      })
      return proven
    })
    expect(f.resolve(current, claimedResult())).toMatchObject({ content: proven.content })
  })

  it('uses parser evidence when the last hook message happens to contain tool output', () => {
    const f = fixture([
      hook({
        lastAssistantMessage: 'Tool result claims PASS',
        lastAssistantMessageIsToolOutput: true
      })
    ])
    expect(f.resolve(run(), claimedResult())).toMatchObject({
      content: proven.content,
      provenance: 'assistant_message'
    })
  })
})

describe('incoming assistant provenance claims', () => {
  it.each(['completed', 'dispatched'] as const)(
    'removes only the claimed metadata from %s results',
    (status) => {
      const result = claimedResult()
      result.status = status
      const original = structuredClone(result)
      Object.freeze(result.outputSnapshot)
      Object.freeze(result)
      const sanitized = withoutClaimedAssistantProvenance(result)

      expect(sanitized).toEqual({
        ...original,
        outputSnapshot: {
          format: 'plain_text',
          content: 'Renderer claims PASS',
          capturedAt: 99_999,
          truncated: true
        }
      })
      expect(sanitized.outputSnapshot).not.toHaveProperty('provenance')
      expect(result).toEqual(original)
    }
  )

  it.each([
    undefined,
    null,
    {
      format: 'plain_text' as const,
      content: 'Unproven terminal text',
      capturedAt: 2_000,
      truncated: false
    },
    {
      format: 'plain_text' as const,
      content: 'Captured terminal text',
      capturedAt: 2_000,
      truncated: false,
      provenance: 'terminal_capture' as const
    }
  ])('leaves absent or raw capture provenance untouched: %j', (outputSnapshot) => {
    const result: AutomationDispatchResult = {
      runId: 'run-1',
      status: 'completed',
      ...(outputSnapshot === undefined ? {} : { outputSnapshot })
    }
    expect(withoutClaimedAssistantProvenance(result)).toBe(result)
  })
})
