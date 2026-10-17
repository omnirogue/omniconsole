import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_QUESTION_OWNER_ANSWER_CAPABILITY,
  SessionQuestionOwnerAnswerParamsSchema,
  SessionQuestionOwnerAnswerResultSchema,
  SessionQuestionOwnerReadResultSchema,
  type SessionQuestionOwnerReady
} from '../../../../shared/session-question-owner-answer'
import type { SessionManageSidebarRow } from '../../../../shared/session-manage-relay'
import type { GuardedWriteOutcome, WriteFence } from '../../../pty/guarded-pty-write'
import { configureSessionHostSwitches } from '../../../session-host-owner/session-host-switches'
import { withSessionAnswerLock } from '../../../session-manage/session-manage-answer'
import type { ObservedSession } from '../../../session-manage/session-manage-observe'
import { agentProcess } from '../../../session-manage/session-manage-test-fixtures'
import { parseSessionPromptScreen } from '../../../session-manage/session-prompt-screen'
import { readSessionAsyncQuestion } from '../../../session-manage/session-prompt-hook'
import { resetAsyncQuestionAnswerClaimsForTests } from '../../async-question-answer-claims'
import type { TerminalAgentProcessProof } from '../../terminal-agent-process'
import type { RpcContext } from '../core'
import { SESSION_QUESTION_OWNER_METHODS } from './session-question-owner-answer'

const calls = vi.hoisted(() => ({
  observe: vi.fn(),
  stop: vi.fn(() => false),
  audit: vi.fn(async () => undefined),
  notice: vi.fn(),
  pending: new Set<string>(),
  toolUseId: vi.fn<() => string | undefined>(() => 'question-call-1')
}))
vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: { getToolUseIdForPane: calls.toolUseId, dropAsyncQuestion: vi.fn() }
}))
vi.mock('../../../session-manage/session-manage-observe', async (original) => ({
  ...(await original<object>()),
  observeSession: calls.observe
}))
vi.mock('../../../session-manage/session-manage-runtime-sources', () => ({
  createRuntimeObserveSources: () => ({})
}))
vi.mock('../../../session-manage/session-manage-runtime-actions', () => ({
  runtimeDeliveryDeps: () => ({ stopKeepGoing: calls.stop }),
  showSessionManageNotice: calls.notice
}))
vi.mock('../../../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/unused-profile'
}))
vi.mock('../../../session-manage/session-answer-quarantine', () => ({
  PersistentSessionAnswerQuarantine: class {
    has(key: string) {
      return calls.pending.has(key)
    }
    add(key: string) {
      calls.pending.add(key)
    }
    delete(key: string) {
      calls.pending.delete(key)
    }
  }
}))
vi.mock('../../../session-manage/session-actions-log', async (original) => ({
  ...(await original<object>()),
  sessionActionsLogFor: () => ({ append: calls.audit })
}))

const params = {
  runtimeId: 'owner-runtime',
  target: { worktreeId: 'folder:project', paneKey: 'tab:leaf', terminal: 'published-handle' },
  displayed: {
    interactivePrompt: JSON.stringify({
      questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }]
    }),
    stateStartedAt: 1000,
    agentType: 'claude',
    providerSession: { key: 'session_id' as const, id: 'provider-1' }
  }
}
const screen =
  'Which colour?\n❯ 1. Red\n  2. Blue\nEnter to select · ↑/↓ to navigate · Esc to cancel'
let context: RpcContext
let observation: Omit<ObservedSession, 'row'>
let hook: Record<string, unknown> | null
let runtime: ReturnType<typeof makeRuntime>
let restoreSwitch: () => void
let binding: SessionQuestionOwnerReady['binding']

function makeRuntime() {
  return {
    getRuntimeId: vi.fn(() => params.runtimeId),
    resolveTerminalPane: vi.fn(() => ({
      handle: 'canonical-handle',
      ptyId: 'pty-1',
      tabId: 'tab',
      worktreeId: params.target.worktreeId,
      connected: true,
      executionHostId: 'local'
    })),
    getLiveTerminalPaneKey: vi.fn(() => params.target.paneKey),
    getTerminalProcessIncarnation: vi.fn(() => 'pty-1:inc-1'),
    getFreshAgentHookStatusForHandle: vi.fn(() => hook),
    getTerminalLivenessVerdict: vi.fn(() => null),
    assertTerminalAgentProcess: vi.fn(async () => {}),
    readTerminal: vi.fn(async () => ({
      source: 'screen',
      tail: ['• Working (1s • esc to interrupt)']
    })),
    readTerminalProcessEvidence: vi.fn(async () => ({
      proof: observation.agentProcess,
      tree: { kind: 'other' }
    })),
    sendTerminalAgentPrompt: vi.fn(
      async (
        _handle: string,
        _text: string,
        options: Parameters<RpcContext['runtime']['sendTerminalAgentPrompt']>[2]
      ) => {
        for (let i = 0; i < 2; i += 1) {
          await options?.beforeWrite?.('pty-1')
          options?.reserveWrite?.('pty-1')
          options?.afterWrite?.('pty-1')
        }
        hook = { ...hook, interactivePrompt: null, state: 'working', stateStartedAt: 2000 }
        return { handle: 'canonical-handle', accepted: true, bytesWritten: 1 }
      }
    ),
    sendGuardedSessionKey: vi.fn(
      async (
        _handle: string,
        _key: string,
        _receiver: TerminalAgentProcessProof,
        fence: WriteFence
      ): Promise<GuardedWriteOutcome> => {
        if (fence.isRevoked()) {
          return 'revoked'
        }
        observation = {
          ...observation,
          prompt: undefined,
          facts: { ...observation.facts, activity: { kind: 'working' } }
        }
        hook = { ...hook, interactivePrompt: null, state: 'working', stateStartedAt: 2000 }
        return 'written'
      }
    )
  }
}

async function read(overrides = {}, ctx = context) {
  const method = SESSION_QUESTION_OWNER_METHODS[0]!
  return SessionQuestionOwnerReadResultSchema.parse(
    await method.handler(method.params!.parse({ ...params, ...overrides }), ctx)
  )
}
async function answer(overrides = {}, ctx = context) {
  const method = SESSION_QUESTION_OWNER_METHODS[1]!
  return SessionQuestionOwnerAnswerResultSchema.parse(
    await method.handler(
      method.params!.parse({
        ...params,
        binding,
        answer: { kind: 'choose', choice: 2 },
        ...overrides
      }),
      ctx
    )
  )
}

beforeEach(async () => {
  vi.clearAllMocks()
  calls.pending.clear()
  calls.toolUseId.mockReturnValue('question-call-1')
  resetAsyncQuestionAnswerClaimsForTests()
  restoreSwitch = configureSessionHostSwitches({
    readSettings: () => ({ remoteControls: true }),
    environment: {}
  })
  hook = {
    ...params.displayed,
    state: 'waiting',
    updatedAt: 1100,
    lastAssistantMessage: null,
    agentPid: 200
  }
  const parsed = parseSessionPromptScreen('claude', screen, params.displayed.interactivePrompt)!
  observation = {
    source: { kind: 'pty', paneKey: params.target.paneKey, worktreeId: params.target.worktreeId },
    terminal: 'canonical-handle',
    facts: { verdict: 'live', activity: { kind: 'question' }, queueLength: 0, pendingSteps: [] },
    stateBasis: 'screen',
    agentForeground: true,
    agentProcess: agentProcess(),
    lastActivityAt: 1100,
    keepGoing: false,
    prompt: {
      ...parsed,
      delivery: { kind: 'pty', handle: 'canonical-handle', ptyId: 'pty-1', screen }
    }
  }
  calls.observe.mockImplementation(async (row: SessionManageSidebarRow) => ({
    ...observation,
    row
  }))
  runtime = makeRuntime()
  context = {
    runtime: runtime as unknown as RpcContext['runtime'],
    pairedDeviceId: 'macbook-1',
    clientId: 'paired-client',
    clientKind: 'runtime',
    clientCapabilities: [SESSION_QUESTION_OWNER_ANSWER_CAPABILITY]
  }
  const result = await read()
  expect(result.status).toBe('ready')
  binding = (result as SessionQuestionOwnerReady).binding
  vi.clearAllMocks()
})

afterEach(async () => {
  restoreSwitch()
  await withSessionAnswerLock(
    `${params.target.worktreeId}:${params.target.paneKey}`,
    async (lock) => lock.leftPrompt()
  )
})

describe('paired owner question RPC', () => {
  it('reads a headless folder pane with a published-handle alias and no persistent effects', async () => {
    expect(await read()).toMatchObject({
      status: 'ready',
      target: params.target,
      binding,
      question: {
        text: 'Which colour?',
        options: [
          { n: 1, label: 'Red' },
          { n: 2, label: 'Blue' }
        ],
        acceptsText: false
      }
    })
    expect(calls.stop).not.toHaveBeenCalled()
    expect(calls.audit).not.toHaveBeenCalled()
    expect(calls.pending.size).toBe(0)
    expect(runtime.sendGuardedSessionKey).not.toHaveBeenCalled()
  })

  it.each([
    { pairedDeviceId: undefined },
    { clientKind: 'mobile' as const },
    { orchestrationCapability: 'worker' },
    { orchestrationCompatibilityEvidence: { paneKey: 'claimed' } },
    { unattendedCaller: { source: 'cleanup' } }
  ])('refuses non-UI principals before observing: %j', async (extra) => {
    expect(await read({}, { ...context, ...extra } as RpcContext)).toMatchObject({
      status: 'refused',
      code: 'provenance-required'
    })
    expect(await answer({}, { ...context, ...extra } as RpcContext)).toMatchObject({
      status: 'refused',
      code: 'provenance-required'
    })
    expect(calls.observe).not.toHaveBeenCalled()
  })

  it('requires capability negotiation and respects remote-controls settings', async () => {
    expect(await read({}, { ...context, clientCapabilities: [] })).toMatchObject({
      status: 'refused',
      code: 'unsupported-capability'
    })
    const restore = configureSessionHostSwitches({
      readSettings: () => ({ remoteControls: false })
    })
    expect(await answer()).toMatchObject({ status: 'refused', code: 'unsupported-capability' })
    restore()
    expect(calls.observe).not.toHaveBeenCalled()
  })

  it('sends only the chosen guarded key and audits the real paired person', async () => {
    expect(await answer()).toMatchObject({
      status: 'answered',
      delivery: 'confirmed',
      target: params.target,
      binding
    })
    expect(runtime.sendGuardedSessionKey).toHaveBeenCalledExactlyOnceWith(
      'canonical-handle',
      '2',
      expect.objectContaining({ pid: 200 }),
      expect.anything()
    )
    expect(calls.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'remote',
        remote: expect.objectContaining({ peer: 'paired:macbook-1', requester: 'person' })
      })
    )
  })

  it('binds a read to its authenticated paired principal', async () => {
    expect(await answer({}, { ...context, pairedDeviceId: 'macbook-2' })).toMatchObject({
      status: 'refused'
    })
    expect(runtime.sendGuardedSessionKey).not.toHaveBeenCalled()
  })

  it('refuses identical question text, state time and process after its tool call changes', async () => {
    calls.toolUseId.mockReturnValue('question-call-2')
    expect(await answer()).toMatchObject({ status: 'refused' })
    expect(runtime.sendGuardedSessionKey).not.toHaveBeenCalled()
    expect(calls.stop).not.toHaveBeenCalled()
  })

  it('refuses a Claude question without an owner tool-call occurrence', async () => {
    calls.toolUseId.mockReturnValue(undefined)
    expect(await read()).toMatchObject({ status: 'refused' })
    expect(runtime.sendGuardedSessionKey).not.toHaveBeenCalled()
  })

  it('revokes a write when an identical tool call replaces the displayed occurrence after reservation', async () => {
    runtime.sendGuardedSessionKey.mockImplementation(async (_handle, _key, _proof, fence) => {
      calls.toolUseId.mockReturnValue('question-call-2')
      expect(fence.isRevoked()).toBe(true)
      return 'revoked'
    })
    expect(await answer()).toMatchObject({ status: 'refused' })
  })

  it('keeps the displayed binding across same-question heartbeat timestamps', async () => {
    hook = { ...hook, updatedAt: 1200, lastAssistantMessage: 'Unrelated preview refreshed' }
    expect(await read()).toMatchObject({ status: 'ready', binding })
    expect(await answer()).toMatchObject({ status: 'answered', delivery: 'confirmed' })
  })

  it.each([
    'runtime',
    'handle',
    'workspace',
    'ssh',
    'incarnation',
    'provider',
    'agent',
    'question',
    'time',
    'missing-hook',
    'process'
  ])('refuses changed %s before any write', async (change) => {
    if (change === 'runtime') {
      runtime.getRuntimeId.mockReturnValue('replacement')
    }
    if (change === 'handle') {
      runtime.getLiveTerminalPaneKey.mockReturnValue('other:pane')
    }
    if (change === 'workspace') {
      runtime.resolveTerminalPane.mockReturnValue({
        ...runtime.resolveTerminalPane(),
        worktreeId: 'other-folder'
      })
    }
    if (change === 'ssh') {
      runtime.resolveTerminalPane.mockReturnValue({
        ...runtime.resolveTerminalPane(),
        executionHostId: 'ssh:target'
      })
    }
    if (change === 'incarnation') {
      runtime.getTerminalProcessIncarnation.mockImplementation((...args: unknown[]) =>
        args[0] === 'published-handle' ? 'old' : 'new'
      )
    }
    if (change === 'provider') {
      hook = { ...hook, providerSession: { key: 'session_id', id: 'replacement' } }
    }
    if (change === 'agent') {
      hook = { ...hook, agentType: 'codex' }
    }
    if (change === 'question') {
      hook = { ...hook, interactivePrompt: 'replacement' }
    }
    if (change === 'time') {
      hook = { ...hook, stateStartedAt: 2000 }
    }
    if (change === 'missing-hook') {
      hook = null
    }
    if (change === 'process') {
      observation.agentProcess = agentProcess({ pid: 201 })
    }
    expect(await answer()).toMatchObject({ status: 'refused' })
    expect(runtime.sendGuardedSessionKey).not.toHaveBeenCalled()
    expect(calls.stop).not.toHaveBeenCalled()
  })

  it('refuses a provider change during foreground preflight', async () => {
    runtime.assertTerminalAgentProcess.mockImplementation(async () => {
      hook = { ...hook, providerSession: { key: 'session_id', id: 'replacement' } }
    })
    expect(await answer()).toMatchObject({ status: 'refused' })
    expect(runtime.sendGuardedSessionKey).not.toHaveBeenCalled()
    expect(calls.stop).not.toHaveBeenCalled()
  })

  it('revokes the write fence if the owner changes after reservation', async () => {
    runtime.sendGuardedSessionKey.mockImplementation(async (_handle, _key, _proof, fence) => {
      hook = { ...hook, providerSession: { key: 'session_id', id: 'replacement' } }
      expect(fence.isRevoked()).toBe(true)
      return 'revoked'
    })
    expect(await answer()).toMatchObject({ status: 'refused' })
    expect(calls.pending.size).toBe(0)
  })

  it('keeps ambiguous writes quarantined and refuses replay', async () => {
    runtime.sendGuardedSessionKey.mockRejectedValue(new Error('connection lost'))
    expect(await answer()).toMatchObject({ status: 'answered', delivery: 'unconfirmed' })
    expect(await answer()).toMatchObject({ status: 'refused' })
    expect(runtime.sendGuardedSessionKey).toHaveBeenCalledTimes(1)
  })

  it('reports an audit failure after confirmed input as uncertain and never repeats the old binding', async () => {
    calls.audit.mockRejectedValueOnce(new Error('audit disk unavailable'))
    expect(await answer()).toMatchObject({ status: 'answered', delivery: 'unconfirmed' })
    expect(await answer()).toMatchObject({ status: 'refused' })
    expect(runtime.sendGuardedSessionKey).toHaveBeenCalledTimes(1)
  })

  it('keeps ambiguous input quarantined when its partial audit also fails', async () => {
    runtime.sendGuardedSessionKey.mockRejectedValue(new Error('receipt lost'))
    calls.audit.mockRejectedValueOnce(new Error('audit disk unavailable'))
    expect(await answer()).toMatchObject({ status: 'answered', delivery: 'unconfirmed' })
    expect(calls.pending.size).toBeGreaterThan(0)
    expect(await answer()).toMatchObject({ status: 'refused' })
    expect(runtime.sendGuardedSessionKey).toHaveBeenCalledTimes(1)
  })

  it('refuses multi-select, permission prompts and missing process proof on read', async () => {
    observation.prompt!.ask.kind = 'permission'
    expect(await read()).toMatchObject({ status: 'refused' })
    observation.prompt!.ask.kind = 'question'
    observation.agentProcess = null
    expect(await read()).toMatchObject({ status: 'refused' })
    expect(runtime.sendGuardedSessionKey).not.toHaveBeenCalled()
  })

  it('never accepts permission answers, raw input or a forged runtime binding', () => {
    for (const extra of [
      { answer: { kind: 'allow' } },
      { raw: '2\r' },
      { binding: { ...binding, runtimeId: 'other' } }
    ]) {
      expect(
        SessionQuestionOwnerAnswerParamsSchema.safeParse({
          ...params,
          binding,
          answer: { kind: 'choose', choice: 2 },
          ...extra
        }).success
      ).toBe(false)
    }
  })

  async function asyncQuestion() {
    const displayed = {
      ...params.displayed,
      agentType: 'codex',
      interactivePrompt: JSON.stringify({
        delivery: 'async',
        asyncQuestions: [
          {
            question: 'Which colour?',
            options: [{ label: 'Red' }, { label: 'Blue' }],
            askedAt: 1000
          }
        ]
      })
    }
    hook = { ...hook, ...displayed, state: 'done' }
    observation.agentProcess = agentProcess({ agent: 'codex' })
    observation.prompt = readSessionAsyncQuestion(
      { state: 'done', interactivePrompt: displayed.interactivePrompt, stateStartedAt: 1000 },
      { handle: 'canonical-handle', ptyId: 'pty-1' }
    )!
    const ready = await read({ displayed })
    expect(ready).toMatchObject({ status: 'ready', question: { acceptsText: true } })
    binding = (ready as SessionQuestionOwnerReady).binding
    return displayed
  }

  it('answers proven Codex free text through its guarded message path with paired provenance', async () => {
    const displayed = await asyncQuestion()
    expect(
      await answer({ displayed, answer: { kind: 'text', text: 'Choose green' } })
    ).toMatchObject({ status: 'answered', delivery: 'confirmed' })
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'canonical-handle',
      expect.stringContaining('[from person on paired computer] Choose green'),
      expect.objectContaining({
        receiver: expect.objectContaining({ agent: 'codex', pid: 200 }),
        writeFence: expect.any(String)
      })
    )
    expect(runtime.sendGuardedSessionKey).not.toHaveBeenCalled()
  })

  it('refuses Enter after a provider replacement between async paste and submit', async () => {
    const displayed = await asyncQuestion()
    let writes = 0
    runtime.sendTerminalAgentPrompt.mockImplementation(async (_handle, _text, options) => {
      await options?.beforeWrite?.('pty-1')
      options?.reserveWrite?.('pty-1')
      writes += 1
      options?.afterWrite?.('pty-1')
      hook = { ...hook, providerSession: { key: 'session_id', id: 'replacement' } }
      await options?.beforeWrite?.('pty-1')
      writes += 1
      return { handle: 'canonical-handle', accepted: true, bytesWritten: 1 }
    })
    expect(
      await answer({ displayed, answer: { kind: 'text', text: 'Choose green' } })
    ).toMatchObject({ status: 'answered', delivery: 'unconfirmed' })
    expect(writes).toBe(1)
    expect(runtime.sendGuardedSessionKey).not.toHaveBeenCalled()
  })
})
