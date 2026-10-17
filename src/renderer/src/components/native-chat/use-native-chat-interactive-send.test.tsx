// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  inferQuestionAnswered: vi.fn(() => Promise.resolve(true)),
  sendRuntimePtyInput: vi.fn(),
  sendNativeChatAskAnswer: vi.fn(),
  sendNativeChatMessage: vi.fn(),
  sendProvenAgentQuestionAnswer: vi.fn(),
  // Mutable so a test can swap the live status between sendAnswer and settle.
  storeState: { agentStatusByPaneKey: {} as Record<string, unknown> }
}))

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const waitingQuestion = {
  state: 'waiting' as const,
  prompt: 'pick one',
  updatedAt: Date.now(),
  stateStartedAt: Date.now(),
  agentType: 'claude' as const,
  paneKey: PANE_KEY,
  stateHistory: [],
  toolName: 'AskUserQuestion'
}

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => mocks.storeState
  }
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (...args: unknown[]) => mocks.sendRuntimePtyInput(...args)
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: (terminalTabId: string) => ({ terminalTabId })
}))

vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatAskAnswer: (...args: unknown[]) => mocks.sendNativeChatAskAnswer(...args),
  sendNativeChatMessage: (...args: unknown[]) => mocks.sendNativeChatMessage(...args)
}))

vi.mock('./native-chat-proven-answer-send', () => ({
  sendProvenAgentQuestionAnswer: (...args: unknown[]) =>
    mocks.sendProvenAgentQuestionAnswer(...args)
}))

import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'
import type { AskPrompt } from './native-chat-interactive-prompt'

const PROMPT: AskPrompt = {
  questions: [{ question: 'q', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }]
}

describe('useNativeChatInteractiveSend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeState = { agentStatusByPaneKey: { [PANE_KEY]: waitingQuestion } }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { agentStatus: { inferQuestionAnswered: mocks.inferQuestionAnswered } }
    })
    const handle = { cancel: mocks.cancel, settleAfterMs: 500 }
    mocks.sendNativeChatAskAnswer.mockReturnValue(handle)
    mocks.sendNativeChatMessage.mockReturnValue(handle)
  })

  it('routes a non-selector answer through the pasted-text send path', () => {
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'pi')
    )

    act(() => result.current.sendAnswer(PROMPT, [{ indices: [1] }]))

    // Pi commits a pasted answer: label text 'B', not option-number keystrokes.
    expect(mocks.sendNativeChatMessage).toHaveBeenCalledWith(
      { terminalTabId: 'tab-1' },
      'pty-1',
      'B'
    )
    expect(mocks.sendNativeChatAskAnswer).not.toHaveBeenCalled()
  })

  it('routes a Codex answer through the option-number keystroke path', () => {
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'codex')
    )

    act(() => result.current.sendAnswer(PROMPT, [{ indices: [1] }]))

    // Codex's request_user_input card ignores typed labels (STA-1860 shape):
    // the 2nd option is delivered as its digit '2', which selects AND commits.
    expect(mocks.sendNativeChatAskAnswer).toHaveBeenCalledWith(
      { terminalTabId: 'tab-1' },
      'pty-1',
      [{ raw: '2' }],
      expect.any(Function)
    )
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
  })

  it.each(['omp', 'grok'] as const)(
    'delivers a %s nondefault choice as verified arrows and Enter, not pasted labels',
    (agent) => {
      const onDeliverySettled = vi.fn()
      const { result } = renderHook(() =>
        useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', agent)
      )

      act(() => result.current.sendAnswer(PROMPT, [{ indices: [1] }], onDeliverySettled))

      expect(mocks.sendNativeChatAskAnswer).toHaveBeenCalledWith(
        { terminalTabId: 'tab-1' },
        'pty-1',
        [{ raw: '\x1b[A' }, { raw: '\x1b[A' }, { raw: '\x1b[B' }, { raw: '\r' }],
        expect.any(Function)
      )
      expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
      expect(onDeliverySettled).not.toHaveBeenCalled()
      mocks.sendNativeChatAskAnswer.mock.calls[0]?.[3](true)
      expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith(true)
    }
  )

  it('does not send a trailing Enter after Codex submits a multi-question answer', () => {
    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    }
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'codex')
    )

    act(() => result.current.sendAnswer(prompt, [{ indices: [1] }, { indices: [0] }]))

    expect(mocks.sendNativeChatAskAnswer.mock.calls[0]?.[2]).toEqual([{ raw: '2' }, { raw: '1' }])
  })

  it('routes a Claude answer through the option-number keystroke path', () => {
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'claude')
    )

    act(() => result.current.sendAnswer(PROMPT, [{ indices: [1] }]))

    // The 2nd option is delivered as its number '2', not the label 'B' (STA-1860).
    expect(mocks.sendNativeChatAskAnswer).toHaveBeenCalledWith(
      { terminalTabId: 'tab-1' },
      'pty-1',
      [{ raw: '2' }],
      expect.any(Function)
    )
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
  })

  it('infers OpenClaude answers through its Claude-compatible selector path', () => {
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'openclaude')
    )

    act(() => result.current.sendAnswer(PROMPT, [{ indices: [1] }]))

    const onSettled = mocks.sendNativeChatAskAnswer.mock.calls[0]?.[3]
    expect(onSettled).toBeTypeOf('function')
    onSettled?.(true)
    expect(mocks.inferQuestionAnswered).toHaveBeenCalledOnce()
  })

  it('does nothing when no option is answered', () => {
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'claude')
    )

    let resultValue: ReturnType<typeof result.current.sendAnswer> | undefined
    act(() => {
      resultValue = result.current.sendAnswer(PROMPT, [{ indices: [] }])
    })

    expect(resultValue).toEqual({ settleAfterMs: 0, waitsForVerifiedDelivery: false })
    expect(mocks.sendNativeChatAskAnswer).not.toHaveBeenCalled()
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
  })

  it('cancels delayed answer writes when the PTY target changes', () => {
    const { result, rerender } = renderHook(
      ({ targetPtyId }) => useNativeChatInteractiveSend('tab-1', PANE_KEY, targetPtyId, 'codex'),
      { initialProps: { targetPtyId: 'pty-1' as string | null } }
    )

    act(() => result.current.sendAnswer(PROMPT, [{ indices: [0] }]))
    rerender({ targetPtyId: 'pty-2' })

    expect(mocks.cancel).toHaveBeenCalledOnce()
  })

  it('cancels delayed answer writes when the pane identity changes', () => {
    const { result, rerender } = renderHook(
      ({ paneKey }) => useNativeChatInteractiveSend('tab-1', paneKey, 'pty-1', 'claude'),
      { initialProps: { paneKey: PANE_KEY } }
    )

    act(() => result.current.sendAnswer(PROMPT, [{ indices: [0] }]))
    rerender({ paneKey: 'tab-1:22222222-2222-4222-8222-222222222222' })

    expect(mocks.cancel).toHaveBeenCalledOnce()
  })

  it('cancels delayed answer writes before interrupting the active PTY', () => {
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'claude')
    )

    act(() => result.current.sendAnswer(PROMPT, [{ indices: [1] }]))
    act(() => result.current.cancel())

    expect(mocks.cancel).toHaveBeenCalledOnce()
    expect(mocks.sendRuntimePtyInput).toHaveBeenCalledWith(
      { terminalTabId: 'tab-1' },
      'pty-1',
      '\x1b'
    )
  })

  it('can cancel delayed writes without interrupting the replacement prompt', () => {
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'claude')
    )

    act(() => result.current.sendAnswer(PROMPT, [{ indices: [1] }]))
    act(() => result.current.cancelPending())

    expect(mocks.cancel).toHaveBeenCalledOnce()
    expect(mocks.sendRuntimePtyInput).not.toHaveBeenCalled()
  })

  it('infers a Claude question answer only after every runtime write was delivered', () => {
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'claude')
    )

    act(() => result.current.sendAnswer(PROMPT, [{ indices: [1] }]))
    expect(mocks.inferQuestionAnswered).not.toHaveBeenCalled()

    const onSettled = mocks.sendNativeChatAskAnswer.mock.calls[0]?.[3]
    expect(onSettled).toBeTypeOf('function')
    onSettled?.(false)
    expect(mocks.inferQuestionAnswered).not.toHaveBeenCalled()
    onSettled?.(true)

    expect(mocks.inferQuestionAnswered).toHaveBeenCalledExactlyOnceWith({
      paneKey: PANE_KEY,
      baselineUpdatedAt: waitingQuestion.updatedAt,
      baselineStateStartedAt: waitingQuestion.stateStartedAt,
      baselinePrompt: 'pick one',
      baselineAgentType: 'claude'
    })
  })

  it('infers the answered question baseline, not a replacement that became current mid-send', () => {
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'claude')
    )

    // Answer question A while it is the current waiting question.
    act(() => result.current.sendAnswer(PROMPT, [{ indices: [1] }]))

    // A different AskUserQuestion becomes current before the paced send settles.
    mocks.storeState = {
      agentStatusByPaneKey: {
        [PANE_KEY]: {
          ...waitingQuestion,
          prompt: 'second question',
          updatedAt: waitingQuestion.updatedAt + 5000,
          stateStartedAt: waitingQuestion.stateStartedAt + 5000
        }
      }
    }

    const onSettled = mocks.sendNativeChatAskAnswer.mock.calls[0]?.[3]
    onSettled?.(true)

    // The baseline is question A's (captured before delivery), so the server can
    // reject it against the now-current question B instead of clearing B's wait.
    expect(mocks.inferQuestionAnswered).toHaveBeenCalledExactlyOnceWith({
      paneKey: PANE_KEY,
      baselineUpdatedAt: waitingQuestion.updatedAt,
      baselineStateStartedAt: waitingQuestion.stateStartedAt,
      baselinePrompt: 'pick one',
      baselineAgentType: 'claude'
    })
  })

  it('reports verified delivery settlement to the question card', () => {
    const onDeliverySettled = vi.fn()
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'claude')
    )

    let sendResult: ReturnType<typeof result.current.sendAnswer> | undefined
    act(() => {
      sendResult = result.current.sendAnswer(PROMPT, [{ indices: [1] }], onDeliverySettled)
    })
    expect(sendResult).toEqual({ settleAfterMs: 500, waitsForVerifiedDelivery: true })

    const onSettled = mocks.sendNativeChatAskAnswer.mock.calls[0]?.[3]
    onSettled?.(false)
    expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith(false)

    act(() => result.current.cancelPending())
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('keeps a Claude answer retryable while the terminal still shows its selector', () => {
    vi.useFakeTimers()
    try {
      const onDeliverySettled = vi.fn()
      const selectorScreen = 'q\n❯ 1. A\nEnter to select · ↑/↓ to navigate · Esc to cancel'
      const { result } = renderHook(() =>
        useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'claude', () => selectorScreen)
      )
      act(() => result.current.sendAnswer(PROMPT, [{ indices: [1] }], onDeliverySettled))

      // The PTY accepted every key, but Claude never took the answer.
      mocks.sendNativeChatAskAnswer.mock.calls[0]?.[3]?.(true)
      vi.runAllTimers()

      expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith(false)
      expect(mocks.inferQuestionAnswered).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('confirms a Claude answer once its selector has left the terminal', () => {
    const onDeliverySettled = vi.fn()
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'claude', () => '✳ Thinking…')
    )
    act(() => result.current.sendAnswer(PROMPT, [{ indices: [1] }], onDeliverySettled))

    mocks.sendNativeChatAskAnswer.mock.calls[0]?.[3]?.(true)

    expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith(true)
    expect(mocks.inferQuestionAnswered).toHaveBeenCalledOnce()
  })

  it("answers a Codex async question only through the host's proven door", async () => {
    let resolveSettled: () => void = () => {}
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    mocks.sendProvenAgentQuestionAnswer.mockReturnValue({
      cancel: mocks.cancel,
      settleAfterMs: 150,
      settled,
      wasSubmitted: () => false
    })
    const onDeliverySettled = vi.fn()
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'codex')
    )
    const asyncPrompt: AskPrompt = { ...PROMPT, delivery: 'async' }
    let sendResult: ReturnType<typeof result.current.sendAnswer> | undefined
    act(() => {
      sendResult = result.current.sendAnswer(asyncPrompt, [{ indices: [1] }], onDeliverySettled)
    })
    expect(mocks.sendProvenAgentQuestionAnswer).toHaveBeenCalledExactlyOnceWith({
      ptyId: 'pty-1',
      paneKey: PANE_KEY,
      text: '> q\n\nB'
    })
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
    expect(mocks.sendNativeChatAskAnswer).not.toHaveBeenCalled()
    expect(sendResult?.waitsForVerifiedDelivery).toBe(true)
    // A refusal (no proof Codex holds the terminal) keeps the card open to retry.
    await act(async () => {
      resolveSettled()
      await settled
    })
    expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('hands the host the async questions an answer skips, to end once it lands', () => {
    mocks.sendProvenAgentQuestionAnswer.mockReturnValue({
      cancel: mocks.cancel,
      settleAfterMs: 150,
      settled: new Promise<void>(() => {}),
      wasSubmitted: () => false
    })
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', 'codex')
    )
    const asyncPrompt: AskPrompt = {
      delivery: 'async',
      questions: [
        { ...PROMPT.questions[0]!, askedAt: 3 },
        { question: 'Anything else?', multiSelect: false, options: [], askedAt: 4 }
      ]
    }
    act(() => {
      result.current.sendAnswer(asyncPrompt, [{ indices: [1] }, { indices: [] }])
    })
    expect(mocks.sendProvenAgentQuestionAnswer).toHaveBeenCalledExactlyOnceWith({
      ptyId: 'pty-1',
      paneKey: PANE_KEY,
      text: '> q\n\nB',
      leftOut: [{ question: 'Anything else?', askedAt: 4 }]
    })
  })
})
