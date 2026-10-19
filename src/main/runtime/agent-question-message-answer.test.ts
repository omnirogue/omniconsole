import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalAgentProcessProof } from '../../shared/pty-agent-process-evidence'
import {
  answerAgentQuestionWithProof,
  type AgentQuestionAnswerRuntime
} from './agent-question-message-answer'
import { resetAsyncQuestionAnswerClaimsForTests } from './async-question-answer-claims'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const ASK = JSON.stringify({
  delivery: 'async',
  asyncQuestions: [{ question: 'Which color?', multiSelect: false, options: [{ label: 'Red' }] }]
})
const ANSWER = '> Which color?\n\nRed'
const PROOF: TerminalAgentProcessProof = {
  ptyId: 'pty-1',
  incarnationId: 'inc-1',
  rootPid: 100,
  pid: 200,
  pgid: 200,
  startTimeMs: 1_000,
  agent: 'codex',
  via: 'command-line'
}

type Options = {
  hook?: {
    state: string
    workingMode?: string
    interactivePrompt: string | null
    agentPid?: number
    agentType?: string
  } | null
  evidence?: { proof: TerminalAgentProcessProof | null; tree: { kind: string } } | null
  executionHostId?: string
  assert?: () => Promise<void>
  send?: AgentQuestionAnswerRuntime['sendTerminalAgentPrompt']
}

function runtime(options: Options = {}) {
  const sendTerminalAgentPrompt = vi.fn(
    options.send ??
      (async (
        _handle: string,
        _text: string,
        send?: Parameters<AgentQuestionAnswerRuntime['sendTerminalAgentPrompt']>[2]
      ) => {
        // The runtime's own order: proof, reservation, write, landed, for the paste then Enter.
        for (let write = 0; write < 2; write += 1) {
          await send?.beforeWrite?.('pty-1')
          send?.reserveWrite?.('pty-1')
          send?.afterWrite?.('pty-1')
        }
        return { handle: 'term_1', accepted: true, bytesWritten: 1 }
      })
  )
  const assertTerminalAgentProcess = vi.fn(options.assert ?? (async () => {}))
  const fake = {
    resolveTerminalPane: vi.fn(() => ({
      handle: 'term_1',
      tabId: 'tab-1',
      leafId: 'leaf',
      ptyId: 'pty-1',
      connected: true,
      executionHostId: options.executionHostId ?? 'local'
    })),
    getFreshAgentHookStatusForHandle: vi.fn(() =>
      options.hook === undefined
        ? { state: 'done', interactivePrompt: ASK, agentPid: 200 }
        : options.hook
    ),
    readTerminalProcessEvidence: vi.fn(async () =>
      options.evidence === undefined ? { proof: PROOF, tree: { kind: 'other' } } : options.evidence
    ),
    assertTerminalAgentProcess,
    sendTerminalAgentPrompt
  }
  return fake as unknown as AgentQuestionAnswerRuntime & typeof fake
}

const request = { ptyId: 'pty-1', paneKey: PANE, text: ANSWER, clientMessageId: 'chat:1' }

describe('a message answer to a Codex async question', () => {
  beforeEach(() => resetAsyncQuestionAnswerClaimsForTests())

  it('is written only to the proven Codex, guarded at every write, Enter included', async () => {
    const rt = runtime()
    await expect(answerAgentQuestionWithProof(rt, request, vi.fn())).resolves.toEqual({
      status: 'delivered'
    })
    expect(rt.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term_1',
      ANSWER,
      expect.objectContaining({
        clientMessageId: 'chat:1',
        receiver: PROOF,
        writeFence: expect.any(String)
      })
    )
    // Once up front, then before the paste and before Enter.
    expect(rt.assertTerminalAgentProcess).toHaveBeenCalledTimes(3)
    expect(rt.assertTerminalAgentProcess).toHaveBeenCalledWith(PROOF, 'pty-1')
  })

  it('drops the question and sends nothing once the host proves Codex gone', async () => {
    const rt = runtime({ evidence: { proof: null, tree: { kind: 'agent-gone' } } })
    const onAgentGone = vi.fn()
    const outcome = await answerAgentQuestionWithProof(rt, request, onAgentGone)
    expect(outcome).toMatchObject({ status: 'not-sent', reason: /no longer running/ })
    expect(onAgentGone).toHaveBeenCalledWith(PANE)
    expect(rt.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it.each([
    ['no evidence (Windows, an older SSH relay)', null],
    ['no foreground agent', { proof: null, tree: { kind: 'other' } }],
    ['another agent in front', { proof: { ...PROOF, agent: 'claude' }, tree: { kind: 'other' } }]
  ])('fails closed with %s', async (_name, evidence) => {
    const rt = runtime({ evidence })
    const onAgentGone = vi.fn()
    const outcome = await answerAgentQuestionWithProof(rt, request, onAgentGone)
    expect(outcome).toMatchObject({ status: 'not-sent', reason: /could not be proven/ })
    expect(onAgentGone).not.toHaveBeenCalled()
    expect(rt.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('sends nothing for a question no longer pending, or while a child waits', async () => {
    for (const hook of [
      { state: 'working', interactivePrompt: null },
      { state: 'waiting', interactivePrompt: ASK },
      null
    ]) {
      const rt = runtime({ hook })
      await expect(answerAgentQuestionWithProof(rt, request, vi.fn())).resolves.toMatchObject({
        status: 'not-sent'
      })
      expect(rt.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    }
  })

  it('answers over SSH with the relay’s proof before each write, as #836 shipped', async () => {
    const rt = runtime({ executionHostId: 'ssh:conn-1' })
    await expect(answerAgentQuestionWithProof(rt, request, vi.fn())).resolves.toEqual({
      status: 'delivered'
    })
    const options = rt.sendTerminalAgentPrompt.mock.calls[0]![2]!
    expect(options.receiver).toBeUndefined()
    expect(options.writeFence).toBeUndefined()
    expect(rt.assertTerminalAgentProcess).toHaveBeenCalledTimes(3)
  })

  it('refuses a question reported by another process than the one holding the terminal', async () => {
    const rt = runtime({ hook: { state: 'done', interactivePrompt: ASK, agentPid: 999 } })
    await expect(answerAgentQuestionWithProof(rt, request, vi.fn())).resolves.toMatchObject({
      status: 'not-sent',
      reason: expect.stringMatching(/could not be proven/)
    })
    expect(rt.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('sends one answer per question until Codex reports it, and frees it when nothing was written', async () => {
    const rt = runtime()
    await expect(answerAgentQuestionWithProof(rt, request, vi.fn())).resolves.toEqual({
      status: 'delivered'
    })
    await expect(
      answerAgentQuestionWithProof(rt, { ...request, clientMessageId: 'chat:2' }, vi.fn())
    ).resolves.toMatchObject({ status: 'not-sent', reason: expect.stringMatching(/on its way/) })
    expect(rt.sendTerminalAgentPrompt).toHaveBeenCalledOnce()

    resetAsyncQuestionAnswerClaimsForTests()
    const refused = runtime({
      send: async () => {
        throw new Error('terminal_handle_stale')
      }
    })
    await expect(answerAgentQuestionWithProof(refused, request, vi.fn())).resolves.toMatchObject({
      status: 'not-sent'
    })
    await expect(answerAgentQuestionWithProof(runtime(), request, vi.fn())).resolves.toEqual({
      status: 'delivered'
    })
  })

  it('stops before Enter when Codex leaves mid-send, and never offers it again', async () => {
    let checks = 0
    const rt = runtime({
      assert: async () => {
        checks += 1
        if (checks === 3) {
          throw new Error('The agent it was queued for no longer holds its terminal.')
        }
      }
    })
    await expect(answerAgentQuestionWithProof(rt, request, vi.fn())).resolves.toMatchObject({
      status: 'unconfirmed'
    })
  })

  it('refuses control characters before touching the terminal', async () => {
    const rt = runtime()
    await expect(
      answerAgentQuestionWithProof(rt, { ...request, text: 'Red\x1b[A' }, vi.fn())
    ).resolves.toMatchObject({ status: 'not-sent' })
    expect(rt.readTerminalProcessEvidence).not.toHaveBeenCalled()
  })
})

describe("a message answer to Claude's turn-end question", () => {
  beforeEach(() => resetAsyncQuestionAnswerClaimsForTests())
  const asked = (agentType: string) => ({
    state: 'done',
    interactivePrompt: ASK,
    agentPid: 200,
    agentType
  })
  const holding = (agent: string) => ({ proof: { ...PROOF, agent }, tree: { kind: 'other' } })

  it('is written to the proven Claude that asked it', async () => {
    const rt = runtime({ hook: asked('claude'), evidence: holding('claude') })
    await expect(answerAgentQuestionWithProof(rt, request, vi.fn())).resolves.toEqual({
      status: 'delivered'
    })
  })

  it.each([
    ['Codex holds a terminal whose Claude asked', 'claude', 'codex'],
    ['Claude holds a terminal whose Codex asked', 'codex', 'claude'],
    ['a Claude-shaped agent asked (Kimi)', 'kimi', 'kimi']
  ])('fails closed when %s', async (_name, asker, holder) => {
    const rt = runtime({ hook: asked(asker), evidence: holding(holder) })
    await expect(answerAgentQuestionWithProof(rt, request, vi.fn())).resolves.toMatchObject({
      status: 'not-sent',
      reason: expect.stringMatching(/could not be proven/)
    })
    expect(rt.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
})
