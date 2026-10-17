import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GuardedWriteOutcome, WriteFence } from '../../../pty/guarded-pty-write'
import type { TerminalAgentProcessProof } from '../../terminal-agent-process'
import { revokeWriteFencesWhere } from '../../conversation-write-fence'
import type { PtyLivenessVerdict } from '../../../../shared/pty-liveness-verdict'
import type { SessionPromptAnswer } from '../../../../shared/session-manage-types'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { ObservedSession } from '../../../session-manage/session-manage-observe'
import type * as SessionObservation from '../../../session-manage/session-manage-observe'
import type * as SessionActionLog from '../../../session-manage/session-actions-log'
import { withSessionAnswerLock } from '../../../session-manage/session-manage-answer'
import { agentProcess, sidebarRow } from '../../../session-manage/session-manage-test-fixtures'
import { describeSessionPrompt, type SessionPrompt } from '../../../session-manage/session-prompt'
import { parseSessionPromptScreen } from '../../../session-manage/session-prompt-screen'
import type { RpcContext } from '../core'
import { SESSION_MANAGE_ANSWER_METHOD } from './session-manage-answer-method'

const calls = vi.hoisted(() => ({
  observe: vi.fn(),
  rows: vi.fn(),
  stop: vi.fn(() => true),
  audit: vi.fn(async (): Promise<string | undefined> => undefined),
  notice: vi.fn(),
  pending: new Set<string>()
}))

vi.mock('../../../session-manage/session-manage-observe', async (original) => ({
  ...(await original<typeof SessionObservation>()),
  observeSession: calls.observe
}))
vi.mock('../../../session-manage/session-manage-runtime-sources', () => ({
  createRuntimeObserveSources: () => ({})
}))
vi.mock('../../../session-manage/session-manage-runtime-actions', () => ({
  readSidebarRows: calls.rows,
  runtimePaneVerifier: () => () => 'manager:pane',
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
  ...(await original<typeof SessionActionLog>()),
  sessionActionsLogFor: () => ({ append: calls.audit })
}))

const row = sidebarRow({
  paneKey: 'target:pane',
  kind: 'structured',
  structuredSessionId: 'chat-session'
})
const manager = sidebarRow({ paneKey: 'manager:pane', title: 'Manager' })
let prompt: SessionPrompt
let observation: ObservedSession
let context: RpcContext
let written: string[]
let respond: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  calls.pending.clear()
  const options = [
    { n: 1, label: 'Allow', value: 'allow', role: 'allow-once' as const },
    { n: 2, label: 'Deny', value: 'deny', role: 'deny' as const }
  ]
  prompt = {
    ask: describeSessionPrompt('permission', 'Bash\npwd', options, true, ['pwd']),
    options,
    readable: true,
    subject: 'Bash\npwd',
    commandText: ['pwd'],
    delivery: {
      kind: 'structured',
      sessionId: 'chat-session',
      itemId: 'item-1',
      revision: 2,
      fence: 3
    }
  }
  observation = {
    row,
    source: {
      kind: 'structured',
      paneKey: row.paneKey!,
      worktreeId: row.worktreeId,
      sessionId: 'chat-session'
    },
    terminal: null,
    facts: { verdict: 'live', activity: { kind: 'permission' }, queueLength: 0, pendingSteps: [] },
    stateBasis: 'chat-host',
    agentForeground: null,
    agentProcess: null,
    lastActivityAt: 1,
    keepGoing: true,
    prompt
  }
  calls.observe.mockImplementation(async () => observation)
  calls.rows.mockResolvedValue([row, manager])
  written = []
  respond = vi.fn(async () => ({ ok: true, value: {} }))
  setStructuredAgentSessionHost({
    respondToPrompt: respond
  } as unknown as StructuredAgentSessionHost)
  context = {
    runtime: {} as RpcContext['runtime'],
    orchestrationCompatibilityEvidence: { paneKey: manager.paneKey! }
  }
})

afterEach(async () => {
  for (const [entry] of calls.audit.mock.calls as unknown as [unknown][]) {
    expect(entry).toEqual(
      expect.objectContaining({
        before: expect.objectContaining({
          ask: expect.objectContaining({
            text: expect.any(String),
            fingerprint: expect.any(String)
          }),
          commandText: expect.any(Array)
        }),
        after: expect.objectContaining({
          chosen: expect.objectContaining({ label: expect.any(String), value: expect.any(String) })
        })
      })
    )
  }
  setStructuredAgentSessionHost(null)
  vi.useRealTimers()
  // An answer left unconfirmed closes its prompt to later answers; each test starts clean.
  await withSessionAnswerLock(`${row.worktreeId}:${row.paneKey}`, async (lock) => lock.leftPrompt())
})

function answer(value: SessionPromptAnswer = { kind: 'allow' }, extra = {}, ctx = context) {
  const params = SESSION_MANAGE_ANSWER_METHOD.params!.parse({
    target: { paneKey: row.paneKey },
    expect: prompt.ask.fingerprint,
    answer: value,
    reason: 'Safe inspection',
    request: 'Unblock the parser session',
    ...extra
  })
  return SESSION_MANAGE_ANSWER_METHOD.handler(params, ctx)
}

function pty() {
  const screen = 'Bash command\n  pwd\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel'
  const parsed = parseSessionPromptScreen('claude', screen)!
  prompt = { ...parsed, delivery: { kind: 'pty', handle: 'term_1', ptyId: 'pty-1', screen } }
  observation = {
    ...observation,
    row: { ...row, kind: 'terminal', structuredSessionId: null },
    prompt,
    source: { kind: 'pty', paneKey: row.paneKey!, worktreeId: row.worktreeId },
    terminal: 'term_1',
    stateBasis: 'screen',
    agentForeground: true,
    agentProcess: agentProcess({ ptyId: 'pty-1' })
  }
  calls.rows.mockResolvedValue([observation.row, manager])
  const events: string[] = []
  const runtime = {
    events,
    assertTerminalAgentProcess: vi.fn(async (_proof: unknown, ptyId: string) => {
      events.push(`verify:${ptyId}`)
    }),
    resolveTerminalPane: vi.fn(
      (): { handle: string; ptyId: string | null; connected: boolean } => ({
        handle: 'term_1',
        ptyId: 'pty-1',
        connected: true
      })
    ),
    getTerminalLivenessVerdict: vi.fn((): PtyLivenessVerdict | null | undefined => null),
    getFreshAgentHookStatusForHandle: vi.fn((): { state: string } | null => ({
      state: 'blocked'
    })),
    readTerminal: vi.fn(async () => ({
      source: 'screen',
      tail: ['• Working (1s • esc to interrupt)']
    })),
    sendGuardedSessionKey: vi.fn(
      async (
        _handle: string,
        key: string,
        _receiver: TerminalAgentProcessProof,
        fence: WriteFence
      ): Promise<GuardedWriteOutcome> => {
        if (fence.isRevoked()) {
          return 'revoked'
        }
        written.push(key)
        events.push(`write:${key}`)
        observation = {
          ...observation,
          prompt: undefined,
          facts: { ...observation.facts, activity: { kind: 'working' } }
        }
        return 'written'
      }
    )
  }
  context.runtime = runtime as unknown as RpcContext['runtime']
  return runtime
}

describe('sessionManage.answer RPC', () => {
  it('requires --expect and refuses remote clients and dispatch capabilities before reading', async () => {
    expect(() => answer({ kind: 'allow' }, { expect: undefined })).toThrow()
    for (const rejected of [
      { clientId: 'remote' },
      { clientKind: 'mobile' as const },
      { orchestrationCapability: 'worker' }
    ]) {
      await expect(answer({ kind: 'deny' }, {}, { ...context, ...rejected })).rejects.toThrow()
    }
    expect(calls.rows).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
  })

  it('uses the structured approval response path with revision, fence and actor provenance', async () => {
    expect(await answer()).toMatchObject({
      delivery: 'recorded',
      summary: expect.stringContaining('Provider delivery is not confirmed.')
    })
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      { callerKey: 'session-manage:manager:pane' },
      expect.objectContaining({
        kind: 'approval',
        itemId: 'item-1',
        expectedRevision: 2,
        optionId: 'allow',
        envelope: expect.objectContaining({
          expectedRuntimeFence: 3,
          sessionId: 'chat-session',
          payloadFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      })
    )
  })

  it('uses the structured question response path for choices and marked free text', async () => {
    prompt.ask = describeSessionPrompt(
      'question',
      'Which parser?',
      [{ n: 1, label: 'Existing', value: 'q1:existing' }],
      true
    )
    prompt.options = [{ n: 1, label: 'Existing', value: 'q1:existing' }]
    prompt.delivery = {
      kind: 'structured',
      sessionId: 'chat-session',
      itemId: 'item-1',
      revision: 2,
      fence: 3,
      freeTextQuestionId: 'q1'
    }
    await answer({ kind: 'choose', choice: 1 })
    expect(respond.mock.calls[0]?.[1]).toMatchObject({ kind: 'question', optionId: 'q1:existing' })
    await expect(answer({ kind: 'text', text: 'Existing parser' })).rejects.toThrow(
      'may already have reached'
    )
    prompt.delivery = { ...prompt.delivery, itemId: 'item-2' }
    await answer({ kind: 'text', text: 'Existing parser' })
    expect(respond.mock.calls[1]?.[1]).toMatchObject({
      kind: 'question',
      itemId: 'item-2',
      optionId: 'q1:%5Bfrom%20Manager%5D%20Existing%20parser'
    })
  })

  it('writes exactly one audit record with actor, target, prompt, choice, reason and request', async () => {
    await answer()
    expect(calls.audit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: 'answer',
        actor: { paneKey: 'manager:pane', title: 'Manager' },
        target: expect.objectContaining({ paneKey: row.paneKey }),
        before: { ask: prompt.ask, commandText: prompt.commandText, keepGoing: true },
        after: {
          chosen: { n: 1, label: 'Allow', value: 'allow' },
          delivery: 'recorded',
          keepGoing: false
        },
        reason: 'Safe inspection',
        request: 'Unblock the parser session'
      })
    )
  })

  it('dry-run sends and audits nothing', async () => {
    expect(await answer({ kind: 'allow' }, { dryRun: true })).toMatchObject({ delivery: 'dry-run' })
    expect(respond).not.toHaveBeenCalled()
    expect(calls.stop).not.toHaveBeenCalled()
    expect(calls.audit).not.toHaveBeenCalled()
  })

  it('applies the structured RPC option-size limit even during dry-run', async () => {
    prompt.ask = describeSessionPrompt('question', 'Which parser?', [], true)
    prompt.options = []
    prompt.delivery = {
      kind: 'structured',
      sessionId: 'chat-session',
      itemId: 'item-1',
      revision: 2,
      fence: 3,
      freeTextQuestionId: 'q1'
    }
    await expect(
      answer({ kind: 'text', text: 'a'.repeat(600) }, { dryRun: true })
    ).rejects.toThrow()
    expect(calls.stop).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
  })

  it('refuses a revision change after Keep going stops even with the same public fingerprint', async () => {
    calls.stop.mockImplementationOnce(() => {
      observation = {
        ...observation,
        prompt: {
          ...prompt,
          delivery: {
            kind: 'structured',
            sessionId: 'chat-session',
            itemId: 'item-1',
            revision: 3,
            fence: 3
          }
        }
      }
      return true
    })
    await expect(answer()).rejects.toThrow('identity, options or screen changed')
    expect(respond).not.toHaveBeenCalled()
  })

  it('refuses a prompt already resolved by another structured client', async () => {
    // Keep going was already off, so nothing at all changed: no audit line.
    calls.stop.mockReturnValue(false)
    respond.mockResolvedValue({ ok: false, refusal: { message: 'Already resolved' } })
    await expect(answer()).rejects.toThrow('Already resolved')
    expect(calls.audit).not.toHaveBeenCalled()
    calls.stop.mockReturnValue(true)
  })

  it('audits a refusal after Keep going was turned off as partly applied', async () => {
    respond.mockResolvedValue({ ok: false, refusal: { message: 'Already resolved' } })
    await expect(answer()).rejects.toThrow('Already done: its Keep going was turned off')
    expect(calls.audit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: 'answer',
        summary: expect.stringContaining('Partly applied'),
        after: expect.objectContaining({
          applied: 'its Keep going was turned off',
          completed: false
        })
      })
    )
  })

  it('writes only the minimal PTY key, checks before writing, and confirms departure', async () => {
    vi.useFakeTimers()
    const runtime = pty()
    let settled = false
    const pending = Promise.resolve(answer()).then((result) => {
      settled = true
      return result
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(settled).toBe(false)
    expect(runtime.readTerminal).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(250)
    expect(await pending).toMatchObject({ delivery: 'confirmed' })
    expect(written).toEqual(['1'])
    expect(respond).not.toHaveBeenCalled()
  })

  it('proves the bound agent process before Keep going changes and again before the keystroke', async () => {
    vi.useFakeTimers()
    const runtime = pty()
    const pending = answer()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toMatchObject({ delivery: 'confirmed' })
    // Preflight, then the write boundary, then the one keystroke.
    expect(runtime.events).toEqual(['verify:pty-1', 'verify:pty-1', 'write:1'])
    expect(runtime.assertTerminalAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 200, startTimeMs: -60_000, incarnationId: 'inc-1' }),
      'pty-1'
    )
    expect(runtime.assertTerminalAgentProcess.mock.invocationCallOrder[0]).toBeLessThan(
      calls.stop.mock.invocationCallOrder[0]!
    )
  })

  it('types nothing and changes nothing when the agent no longer holds the terminal', async () => {
    const runtime = pty()
    runtime.assertTerminalAgentProcess.mockRejectedValueOnce(
      new Error(
        'The agent it was queued for no longer holds its terminal, so the prompt was not sent.'
      )
    )
    await expect(answer()).rejects.toThrow('no longer holds its terminal')
    expect(written).toEqual([])
    expect(calls.stop).not.toHaveBeenCalled()
    expect(calls.audit).not.toHaveBeenCalled()
  })

  it('aborts at the write boundary and audits a partial when the agent changes after Keep going stops', async () => {
    const runtime = pty()
    runtime.assertTerminalAgentProcess
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error('Its terminal was replaced after the prompt was queued.'))
    await expect(answer()).rejects.toThrow('Already done: its Keep going was turned off')
    expect(written).toEqual([])
    expect(calls.audit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ summary: expect.stringContaining('Partly applied') })
    )
  })

  it('refuses when a different agent process (pid or start time) holds the terminal at the write', async () => {
    pty()
    calls.stop.mockImplementationOnce(() => {
      observation = { ...observation, agentProcess: agentProcess({ ptyId: 'pty-1', pid: 201 }) }
      return true
    })
    await expect(answer()).rejects.toThrow('different process now holds the terminal')
    expect(written).toEqual([])
    calls.stop.mockImplementationOnce(() => {
      observation = {
        ...observation,
        agentProcess: agentProcess({ ptyId: 'pty-1', startTimeMs: 9_000 })
      }
      return true
    })
    observation = { ...observation, agentProcess: agentProcess({ ptyId: 'pty-1' }) }
    await expect(answer()).rejects.toThrow('different process now holds the terminal')
    expect(written).toEqual([])
  })

  it.each([
    ['no process proof', { agentProcess: null }],
    ['a shell in the foreground', { agentForeground: false }],
    ['an unreadable foreground', { agentForeground: null }]
  ] as const)('refuses a terminal answer with %s and types nothing', async (_name, change) => {
    const runtime = pty()
    observation = { ...observation, ...change }
    await expect(answer({ kind: 'deny' })).rejects.toThrow('Nothing was sent')
    expect(runtime.sendGuardedSessionKey).not.toHaveBeenCalled()
    expect(runtime.assertTerminalAgentProcess).not.toHaveBeenCalled()
    expect(calls.stop).not.toHaveBeenCalled()
  })

  it('answers only the exact pane named, never a sibling of its tab', async () => {
    const sibling = { ...row, paneKey: 'target:other' }
    calls.rows.mockResolvedValue([sibling, manager])
    await expect(answer({ kind: 'deny' })).rejects.toThrow('No conversation in the sidebar')
    expect(calls.observe).not.toHaveBeenCalled()
    calls.rows.mockResolvedValue([row, sibling, manager])
    await expect(
      answer({ kind: 'deny' }, { target: { paneKey: row.paneKey, terminal: 'term_sibling' } })
    ).rejects.toThrow('terminal handle changed')
    expect(calls.stop).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
  })

  it.each(['ssh:box', 'runtime:paired'])(
    'refuses a %s target for --deny and dry runs',
    async (hostId) => {
      observation = { ...observation, row: { ...row, hostId } }
      await expect(answer({ kind: 'deny' })).rejects.toThrow('not on this computer')
      await expect(answer({ kind: 'deny' }, { dryRun: true })).rejects.toThrow(
        'not on this computer'
      )
      expect(calls.stop).not.toHaveBeenCalled()
      expect(respond).not.toHaveBeenCalled()
    }
  )

  it('refuses an awaiting-user state that rests on no positive evidence', async () => {
    observation = { ...observation, stateBasis: 'none' }
    await expect(answer({ kind: 'deny' })).rejects.toThrow('not proven to be waiting')
    expect(respond).not.toHaveBeenCalled()
  })

  it('refuses a changed screen at the terminal write boundary and sends nothing', async () => {
    const runtime = pty()
    runtime.sendGuardedSessionKey.mockImplementationOnce(
      async (_handle, _key, _receiver, fence) => {
        observation = { ...observation, prompt: undefined }
        revokeWriteFencesWhere(() => true)
        expect(fence.isRevoked()).toBe(true)
        return 'revoked'
      }
    )
    await expect(answer()).rejects.toThrow('Nothing was sent')
    expect(written).toEqual([])
  })

  it('refuses a replacement terminal handle during the fresh observation', async () => {
    pty()
    calls.observe
      .mockImplementationOnce(async () => observation)
      .mockImplementationOnce(async () => ({ ...observation, terminal: 'term_replacement' }))
    await expect(answer()).rejects.toThrow('target terminal changed')
    expect(calls.stop).not.toHaveBeenCalled()
    expect(written).toEqual([])
  })

  it('still audits an accepted write when its target becomes unverifiable', async () => {
    vi.useFakeTimers()
    const runtime = pty()
    runtime.sendGuardedSessionKey.mockImplementationOnce(
      async (_handle, key, _receiver, _fence) => {
        written.push(key)
        observation = {
          ...observation,
          terminal: null,
          facts: { ...observation.facts, verdict: 'unverifiable' }
        }
        return 'written'
      }
    )
    const pending = answer()
    await vi.advanceTimersByTimeAsync(250)
    expect(await pending).toMatchObject({ delivery: 'unconfirmed' })
    expect(calls.audit).toHaveBeenCalledOnce()
  })

  it('reports and audits unconfirmed PTY delivery without retrying', async () => {
    vi.useFakeTimers()
    const runtime = pty()
    runtime.sendGuardedSessionKey.mockImplementationOnce(
      async (_handle, key, _receiver, _fence) => {
        written.push(key)
        return 'written'
      }
    )
    const pending = answer()
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toMatchObject({ delivery: 'unconfirmed' })
    expect(written).toEqual(['1'])
    expect(calls.audit).toHaveBeenCalledOnce()
  })

  // MINOR-1: the last read before anything changes happens before Keep going is turned off.
  it('refuses a prompt changed before Keep going stops, with nothing changed or audited', async () => {
    const changed: ObservedSession = {
      ...observation,
      prompt: {
        ...prompt,
        delivery: {
          kind: 'structured',
          sessionId: 'chat-session',
          itemId: 'item-1',
          revision: 3,
          fence: 3
        }
      }
    }
    calls.observe
      .mockImplementationOnce(async () => observation)
      .mockImplementationOnce(async () => observation)
      .mockImplementationOnce(async () => changed)
    await expect(answer()).rejects.toThrow('identity, options or screen changed')
    expect(calls.stop).not.toHaveBeenCalled()
    expect(calls.audit).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
  })

  // MAJOR-1: only positive evidence reserves a keystroke.
  it.each([
    [
      'an unobserved (undefined) liveness',
      (rt: ReturnType<typeof pty>) => rt.getTerminalLivenessVerdict.mockReturnValue(undefined)
    ],
    [
      'an unverifiable terminal',
      (rt: ReturnType<typeof pty>) =>
        rt.getTerminalLivenessVerdict.mockReturnValue({ status: 'unverifiable', reason: 'lost' })
    ],
    [
      'an exited terminal',
      (rt: ReturnType<typeof pty>) =>
        rt.getTerminalLivenessVerdict.mockReturnValue({ status: 'exited' })
    ],
    [
      'a live verdict for another PTY',
      (rt: ReturnType<typeof pty>) =>
        rt.getTerminalLivenessVerdict.mockReturnValue({ status: 'live', ptyIds: ['pty-other'] })
    ],
    [
      'a pane now on another handle',
      (rt: ReturnType<typeof pty>) =>
        rt.resolveTerminalPane.mockReturnValue({
          handle: 'term_9',
          ptyId: 'pty-1',
          connected: true
        })
    ],
    [
      'an agent report that vanished at the write',
      (rt: ReturnType<typeof pty>) =>
        rt.getFreshAgentHookStatusForHandle
          .mockReturnValueOnce({ state: 'blocked' })
          .mockReturnValue(null)
    ],
    [
      'an agent report that moved on',
      (rt: ReturnType<typeof pty>) =>
        rt.getFreshAgentHookStatusForHandle.mockReturnValue({ state: 'working' })
    ]
  ])('types nothing at the write with %s', async (_name, change) => {
    const runtime = pty()
    change(runtime)
    await expect(answer()).rejects.toThrow('Nothing was sent')
    expect(written).toEqual([])
  })

  // MAJOR-R2-1: the positive evidence is the process proof for this very key.
  it('reserves a key only after the process proof ran and passed for that same key', async () => {
    vi.useFakeTimers()
    const runtime = pty()
    const order: string[] = []
    runtime.assertTerminalAgentProcess.mockImplementation(async (proof: unknown, ptyId: string) => {
      const { pid, startTimeMs } = proof as { pid: number; startTimeMs: number | null }
      order.push(`proof:${ptyId}:pid ${pid}:start ${startTimeMs}`)
    })
    runtime.sendGuardedSessionKey.mockImplementationOnce(
      async (_handle, key, _receiver, _fence) => {
        expect(_receiver).toMatchObject({ pid: 200, startTimeMs: -60_000 })
        order.push('owner-written')
        written.push(key)
        observation = {
          ...observation,
          prompt: undefined,
          facts: { ...observation.facts, activity: { kind: 'working' } }
        }
        return 'written'
      }
    )
    const pending = answer()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toMatchObject({ delivery: 'confirmed' })
    // The preflight proof, then this key's own proof, then the reservation it licensed.
    expect(order).toEqual([
      'proof:pty-1:pid 200:start -60000',
      'proof:pty-1:pid 200:start -60000',
      'owner-written'
    ])
    expect(runtime.getTerminalLivenessVerdict).toHaveBeenCalledWith('term_1')
    expect(written).toEqual(['1'])
  })

  it.each(['refused', 'revoked', 'unsupported'] as const)(
    'keeps a proven owner %s outcome unsent',
    async (outcome) => {
      const runtime = pty()
      runtime.sendGuardedSessionKey.mockImplementationOnce(async () => {
        expect(calls.pending.has(`${row.worktreeId}:${row.paneKey}`)).toBe(true)
        return outcome
      })
      await expect(answer()).rejects.toThrow('Nothing was sent')
      expect(written).toEqual([])
      expect(calls.pending.size).toBe(0)
    }
  )

  it('retains pending state on an unknown owner outcome', async () => {
    const runtime = pty()
    runtime.sendGuardedSessionKey.mockImplementationOnce(async () => {
      expect(calls.pending.has(`${row.worktreeId}:${row.paneKey}`)).toBe(true)
      return 'unknown'
    })
    await expect(answer()).rejects.toThrow('may already have reached')
    expect(calls.pending.has(`${row.worktreeId}:${row.paneKey}`)).toBe(true)
    await expect(answer()).rejects.toThrow('may already have reached')
    expect(runtime.sendGuardedSessionKey).toHaveBeenCalledOnce()
  })

  // R2-MINOR-2: a dry run changes, sends and audits nothing, on a terminal too.
  it('writes no audit line, types nothing and leaves Keep going for a terminal dry run', async () => {
    const runtime = pty()
    expect(await answer({ kind: 'allow' }, { dryRun: true })).toMatchObject({ delivery: 'dry-run' })
    expect(calls.audit).not.toHaveBeenCalled()
    expect(calls.stop).not.toHaveBeenCalled()
    expect(runtime.sendGuardedSessionKey).not.toHaveBeenCalled()
    expect(written).toEqual([])
  })

  // MAJOR-5: only a positive reading of a different state confirms.
  it.each([
    [
      'a state resting on no positive evidence',
      { stateBasis: 'last-report' as const, activity: { kind: 'idle' as const } },
      ['Working'],
      'is not positive evidence'
    ],
    [
      'a prompt menu still up that no longer parses',
      { stateBasis: 'screen' as const, activity: { kind: 'working' as const } },
      ['⏺ partial redraw', '  Esc to cancel · Tab to amend'],
      'the prompt was still showing'
    ],
    [
      'a colored menu footer still up',
      { stateBasis: 'hook' as const, activity: { kind: 'working' as const } },
      ['⏺ Bash(git status)', '\x1b[2mEsc to cancel · Tab to amend\x1b[0m'],
      'the prompt was still showing'
    ],
    [
      'an ANSI-only screen',
      { stateBasis: 'hook' as const, activity: { kind: 'working' as const } },
      ['\x1b[2J\x1b[H'],
      'its screen was empty'
    ],
    [
      'an unrecognized screen',
      { stateBasis: 'hook' as const, activity: { kind: 'working' as const } },
      ['Working'],
      'no recognized departure'
    ],
    [
      'an empty screen',
      { stateBasis: 'hook' as const, activity: { kind: 'working' as const } },
      [],
      'its screen was empty'
    ]
  ])('reports unconfirmed, with its reason, for %s after the key', async (_n, after, tail, why) => {
    vi.useFakeTimers()
    const runtime = pty()
    runtime.readTerminal.mockResolvedValue({ source: 'screen', tail })
    runtime.sendGuardedSessionKey.mockImplementationOnce(
      async (_handle, key, _receiver, _fence) => {
        written.push(key)
        observation = {
          ...observation,
          prompt: undefined,
          stateBasis: after.stateBasis,
          facts: { ...observation.facts, activity: after.activity }
        }
        return 'written'
      }
    )
    const pending = answer()
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toMatchObject({
      delivery: 'unconfirmed',
      summary: expect.stringContaining(why)
    })
    expect(written).toEqual(['1'])
    expect(calls.audit).toHaveBeenCalledOnce()
  })

  it('reports unconfirmed when the screen after the key is not a current screen read', async () => {
    vi.useFakeTimers()
    const runtime = pty()
    runtime.readTerminal.mockResolvedValue({
      source: 'stream',
      tail: ['• Working (1s • esc to interrupt)']
    })
    const pending = answer()
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toMatchObject({
      delivery: 'unconfirmed',
      summary: expect.stringContaining('its screen could not be read')
    })
  })

  // MAJOR-6: a key reserved and then lost is audited as partly applied, never returned as a result,
  // and no second answer fires on that prompt.
  it('audits a write lost after its key was reserved as partial and refuses a second answer', async () => {
    const runtime = pty()
    runtime.sendGuardedSessionKey.mockImplementationOnce(async () => {
      expect(calls.pending.has(`${row.worktreeId}:${row.paneKey}`)).toBe(true)
      throw new Error('pty write EPIPE')
    })
    calls.audit.mockResolvedValueOnce('disk full')
    const failure = await Promise.resolve(answer()).catch((error: unknown) => error)
    expect((failure as Error).message).toContain('may already have reached')
    expect((failure as Error).message).toContain('Audit warning: disk full')
    expect(calls.audit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        summary: expect.stringContaining('Partly applied'),
        before: { ask: prompt.ask, commandText: prompt.commandText, keepGoing: true },
        after: expect.objectContaining({
          chosen: expect.objectContaining({ n: 1, label: 'Yes', value: '1' }),
          delivery: 'unknown',
          applied: 'its Keep going was turned off, and the answer may have been sent',
          completed: false
        })
      })
    )
    await expect(answer()).rejects.toThrow('may already have reached it')
    await expect(answer({ kind: 'deny' }, { dryRun: true })).rejects.toThrow(
      'may already have reached it'
    )
    expect(runtime.sendGuardedSessionKey).toHaveBeenCalledOnce()
  })

  it('records Keep going as unchanged when the answer did not turn it off', async () => {
    calls.stop.mockReturnValue(false)
    try {
      await answer()
      expect(calls.audit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          before: { ask: prompt.ask, commandText: prompt.commandText, keepGoing: true },
          after: {
            chosen: { n: 1, label: 'Allow', value: 'allow' },
            delivery: 'recorded',
            keepGoing: true
          }
        })
      )
    } finally {
      calls.stop.mockReturnValue(true)
    }
  })
})
