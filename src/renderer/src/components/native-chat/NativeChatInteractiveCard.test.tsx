// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { applyCommandMarkerBoundaries } from './native-chat-command-marker'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'

const INITIAL_PROMPT = JSON.stringify({
  questions: [
    {
      question: 'Tabs or spaces?',
      multiSelect: false,
      options: [{ label: 'Tabs' }, { label: 'Spaces' }]
    }
  ]
})

const storeState = {
  agentStatusByPaneKey: {
    'tab-1:leaf-1': {
      interactivePrompt: INITIAL_PROMPT as string | undefined,
      toolName: 'AskUserQuestion' as string | undefined,
      state: undefined as string | undefined
    }
  }
}

const toastMessage = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { message: toastMessage } }))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'

const mocks = {
  sendAnswer: vi.fn<NativeChatInteractiveSend['sendAnswer']>(),
  sendApproval: vi.fn<NativeChatInteractiveSend['sendApproval']>(),
  sendRaw: vi.fn<NativeChatInteractiveSend['sendRaw']>(),
  cancelPending: vi.fn<NativeChatInteractiveSend['cancelPending']>(),
  cancel: vi.fn<NativeChatInteractiveSend['cancel']>()
}

function renderCard(canSend = true): ReturnType<typeof render> {
  return render(cardElement(canSend))
}

function cardElement(
  canSend = true,
  messages?: readonly NativeChatMessage[],
  onShowingQuestionChange?: (showing: boolean) => void,
  transcriptSettled = true
): React.JSX.Element {
  return (
    <NativeChatInteractiveCard
      paneKey="tab-1:leaf-1"
      canSend={canSend}
      messages={messages}
      transcriptSettled={transcriptSettled}
      onShowingQuestionChange={onShowingQuestionChange}
      send={{
        sendAnswer: mocks.sendAnswer,
        sendApproval: mocks.sendApproval,
        sendRaw: mocks.sendRaw,
        cancelPending: mocks.cancelPending,
        cancel: mocks.cancel
      }}
    />
  )
}

function askCallMessage(question: string): NativeChatMessage {
  return {
    id: `call-${question}`,
    role: 'assistant',
    createdAt: 1,
    blocks: [
      {
        type: 'tool-call',
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question,
              header: 'Style',
              multiSelect: false,
              options: [{ label: 'Tabs' }, { label: 'Spaces' }]
            }
          ]
        }
      }
    ]
  } as unknown as NativeChatMessage
}

function askResultMessage(): NativeChatMessage {
  return {
    id: 'result-1',
    role: 'assistant',
    createdAt: 2,
    blocks: [{ type: 'tool-result', name: 'AskUserQuestion', output: 'Tabs' }]
  } as unknown as NativeChatMessage
}

function chooseSpaces(): void {
  fireEvent.click(screen.getByRole('button', { name: /Spaces/ }))
}

describe('NativeChatInteractiveCard answer lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = INITIAL_PROMPT
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].state = undefined
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps the card retryable when no PTY answer was sent', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 0, waitsForVerifiedDelivery: false })
    renderCard()

    chooseSpaces()
    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(mocks.sendAnswer).toHaveBeenCalledTimes(2)
  })

  it('cancels delayed PTY writes when the owning card unmounts', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 5_000, waitsForVerifiedDelivery: false })
    const rendered = renderCard()

    chooseSpaces()
    expect(mocks.cancelPending).not.toHaveBeenCalled()

    rendered.unmount()
    expect(mocks.cancelPending).toHaveBeenCalledOnce()
  })

  it('cancels delayed PTY writes when desktop send authority is lost', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 5_000, waitsForVerifiedDelivery: false })
    const rendered = renderCard()

    chooseSpaces()
    rendered.rerender(cardElement(false))

    expect(mocks.cancelPending).toHaveBeenCalledOnce()
  })

  it('shows the paced send as busy and freezes the snapshotted answer', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 5_000, waitsForVerifiedDelivery: false })
    renderCard()

    chooseSpaces()

    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Spaces/ })).toBeDisabled()
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('sends a single-choice answer once on click and rejects another click while delivering', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 500, waitsForVerifiedDelivery: true })
    renderCard()
    expect(mocks.sendAnswer).not.toHaveBeenCalled()

    chooseSpaces()
    fireEvent.click(screen.getByRole('button', { name: /Spaces/ }))
    fireEvent.click(screen.getByRole('button', { name: /Tabs$/ }))

    expect(mocks.sendAnswer).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      [{ indices: [1], other: '' }],
      expect.any(Function)
    )
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
  })

  it('cancels the old answer sequence when a replacement prompt arrives', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 5_000, waitsForVerifiedDelivery: false })
    const rendered = renderCard()
    chooseSpaces()

    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = JSON.stringify({
      questions: [
        {
          question: 'Choose a shell?',
          multiSelect: false,
          options: [{ label: 'zsh' }, { label: 'bash' }]
        }
      ]
    })
    rendered.rerender(cardElement())

    expect(mocks.cancelPending).toHaveBeenCalledOnce()
    expect(screen.getByText('Choose a shell?')).toBeInTheDocument()
  })

  it('keeps a verified send visible until delivery succeeds', () => {
    let settleDelivery: ((delivered: boolean) => void) | undefined
    mocks.sendAnswer.mockImplementation((_prompt, _selections, onDeliverySettled) => {
      settleDelivery = onDeliverySettled
      return { settleAfterMs: 500, waitsForVerifiedDelivery: true }
    })
    renderCard()

    chooseSpaces()
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()

    act(() => settleDelivery?.(true))
    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()
  })

  it('restores a verified send for retry when delivery is rejected', () => {
    let settleDelivery: ((delivered: boolean) => void) | undefined
    mocks.sendAnswer.mockImplementation((_prompt, _selections, onDeliverySettled) => {
      settleDelivery = onDeliverySettled
      return { settleAfterMs: 500, waitsForVerifiedDelivery: true }
    })
    renderCard()

    chooseSpaces()
    act(() => settleDelivery?.(false))

    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled()
    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
    expect(toastMessage).not.toHaveBeenCalled()
  })

  it.each([
    ['partial', 'Answer partly sent. Finish it in the terminal.'],
    ['not-on-screen', 'Can’t see this question in the terminal. Answer it there.'],
    [
      'not-delivered',
      'The terminal didn’t take the answer. Nothing was sent; open the session to answer it.'
    ]
  ] as const)('tells the person when the answer was refused (%s)', (refusal, notice) => {
    let settleDelivery: Parameters<NativeChatInteractiveSend['sendAnswer']>[2]
    mocks.sendAnswer.mockImplementation((_prompt, _selections, onDeliverySettled) => {
      settleDelivery = onDeliverySettled
      return { settleAfterMs: 500, waitsForVerifiedDelivery: true }
    })
    renderCard()

    chooseSpaces()
    act(() => settleDelivery?.(false, refusal))

    expect(toastMessage).toHaveBeenCalledExactlyOnceWith(notice)
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled()
  })
})

// A headless host, a relay gap, or a replay can leave the pane with no live
// `interactivePrompt` while the transcript still holds the unresolved call (#11761).
// Which asks the transcript still counts as pending (orphaned calls, turn boundaries)
// is the shared parser's contract — covered in `src/shared/native-chat-ask.test.ts`.
describe('NativeChatInteractiveCard transcript fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = undefined
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].state = undefined
  })

  afterEach(() => {
    cleanup()
  })

  it('renders a pending transcript ask and reports the composer replacement', () => {
    const onShowingQuestionChange = vi.fn()
    render(cardElement(true, [askCallMessage('Tabs or spaces?')], onShowingQuestionChange))

    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
    expect(onShowingQuestionChange).toHaveBeenCalledWith(true)
  })

  it('withholds a retained transcript ask while its replacement read is unsettled', () => {
    render(cardElement(true, [askCallMessage('Stale transcript question?')], undefined, false))

    expect(screen.queryByText('Stale transcript question?')).not.toBeInTheDocument()
  })

  it('prefers live status over the transcript when both carry a prompt', () => {
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = INITIAL_PROMPT
    render(cardElement(true, [askCallMessage('Stale transcript question?')]))

    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
    expect(screen.queryByText('Stale transcript question?')).not.toBeInTheDocument()
  })

  it('still renders while the mirrored status says the agent is working', () => {
    // Why no state gate: the mirrored status channel is exactly what fails in the
    // reported topology, so keying the fallback on it would suppress the card.
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].state = 'working'
    render(cardElement(true, [askCallMessage('Tabs or spaces?')]))

    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
  })

  it('stays dismissed after answering while the transcript call is still pending', () => {
    mocks.sendAnswer.mockReturnValue({ settleAfterMs: 500, waitsForVerifiedDelivery: true })
    const messages = [askCallMessage('Tabs or spaces?')]
    const rendered = render(cardElement(true, messages))

    let settleDelivery: ((delivered: boolean) => void) | undefined
    mocks.sendAnswer.mockImplementation((_prompt, _selections, onDeliverySettled) => {
      settleDelivery = onDeliverySettled
      return { settleAfterMs: 500, waitsForVerifiedDelivery: true }
    })
    chooseSpaces()
    act(() => settleDelivery?.(true))
    rendered.rerender(cardElement(true, messages))

    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()
  })

  it('clears once the FIFO tool result lands', () => {
    const rendered = render(cardElement(true, [askCallMessage('Tabs or spaces?')]))
    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()

    rendered.rerender(cardElement(true, [askCallMessage('Tabs or spaces?'), askResultMessage()]))
    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()
  })

  // The view passes the command-boundary-trimmed messages, so an ask abandoned via
  // `/clear` cannot come back as a permanent card sitting over the composer.
  it('drops an ask abandoned by /clear', () => {
    const abandoned = { ...askCallMessage('Tabs or spaces?'), timestamp: 100 }
    const trimmed = applyCommandMarkerBoundaries(
      [abandoned as unknown as NativeChatMessage],
      [{ id: 'clear-1', command: '/clear', sentAt: 200 }]
    )
    render(cardElement(true, trimmed))

    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()
  })

  it('does not reopen an answered question after a transcript read gap', () => {
    const messages = [askCallMessage('Tabs or spaces?')]
    let settle!: (delivered: boolean) => void
    mocks.sendAnswer.mockImplementation((_prompt, _selections, callback) => {
      settle = callback!
      return { settleAfterMs: 500, waitsForVerifiedDelivery: true }
    })
    const rendered = render(cardElement(true, messages))
    chooseSpaces()
    act(() => settle(true))
    rendered.rerender(cardElement(true, messages, undefined, false))
    rendered.rerender(cardElement(true, messages))
    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()
    expect(mocks.sendAnswer).toHaveBeenCalledOnce()

    const next = { ...messages[0]!, id: 'new-question-occurrence' }
    rendered.rerender(cardElement(true, [...messages, askResultMessage(), next]))
    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
  })

  it('retains a live answer through a missing status and a late transcript', () => {
    const status = storeState.agentStatusByPaneKey['tab-1:leaf-1']
    status.interactivePrompt = INITIAL_PROMPT
    let settle!: (delivered: boolean) => void
    mocks.sendAnswer.mockImplementation((_prompt, _selections, callback) => {
      settle = callback!
      return { settleAfterMs: 500, waitsForVerifiedDelivery: true }
    })
    const rendered = render(cardElement())
    chooseSpaces()
    act(() => settle(true))
    status.interactivePrompt = undefined
    rendered.rerender(cardElement())
    status.interactivePrompt = INITIAL_PROMPT
    rendered.rerender(cardElement())
    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()

    const call = askCallMessage('Tabs or spaces?')
    call.blocks = [
      { type: 'tool-call', name: 'AskUserQuestion', input: JSON.parse(INITIAL_PROMPT) }
    ]
    rendered.rerender(cardElement(true, [call]))
    expect(screen.queryByText('Tabs or spaces?')).not.toBeInTheDocument()
    status.interactivePrompt = undefined
    rendered.rerender(cardElement(true, [call, askResultMessage(), { ...call, id: 'new-call' }]))
    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
  })

  it('keeps a rejected answer retryable after a read gap', () => {
    let settle!: (delivered: boolean) => void
    mocks.sendAnswer.mockImplementation((_prompt, _selections, callback) => {
      settle = callback!
      return { settleAfterMs: 500, waitsForVerifiedDelivery: true }
    })
    const messages = [askCallMessage('Tabs or spaces?')]
    const rendered = render(cardElement(true, messages))
    chooseSpaces()
    act(() => settle(false))
    rendered.rerender(cardElement(true, [], undefined, false))
    rendered.rerender(cardElement(true, messages))
    chooseSpaces()
    expect(mocks.sendAnswer).toHaveBeenCalledTimes(2)
  })
})

describe('an async question card', () => {
  const ASYNC_PROMPT = JSON.stringify({
    delivery: 'async',
    asyncQuestions: [
      {
        question: 'Restart the daemon?',
        multiSelect: false,
        options: [{ label: 'Restart' }, { label: 'Keep' }],
        askedAt: 7
      },
      { question: 'Which monitor?', multiSelect: false, options: [{ label: 'Ads' }], askedAt: 8 }
    ]
  })
  const dismissAsyncQuestions = vi.fn(() => Promise.resolve(true))
  const testWindow = window as unknown as { api?: unknown }

  beforeEach(() => {
    vi.clearAllMocks()
    dismissAsyncQuestions.mockReset().mockResolvedValue(true)
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt = ASYNC_PROMPT
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].toolName = undefined
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].state = 'done'
    testWindow.api = { agentStatus: { dismissAsyncQuestions } }
  })

  afterEach(() => {
    cleanup()
    storeState.agentStatusByPaneKey['tab-1:leaf-1'].toolName = 'AskUserQuestion'
    delete testWindow.api
  })

  const answerFirstOnly = (): ((delivered: boolean) => void) => {
    let settle: (delivered: boolean) => void = () => {}
    mocks.sendAnswer.mockImplementation((_prompt, _selections, settled) => {
      settle = (delivered) => settled?.(delivered)
      return { settleAfterMs: 500, waitsForVerifiedDelivery: true }
    })
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: /Restart/ }))
    // Nothing picked on the last question: Skip submits the answer given so far.
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(mocks.sendAnswer).toHaveBeenCalledOnce()
    return (delivered) => settle(delivered)
  }

  it('ends its questions where they are kept when closed, without an Escape', async () => {
    renderCard()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })))

    expect(mocks.cancel).not.toHaveBeenCalled()
    expect(dismissAsyncQuestions).toHaveBeenCalledExactlyOnceWith({
      paneKey: 'tab-1:leaf-1',
      questions: [
        { question: 'Restart the daemon?', askedAt: 7 },
        { question: 'Which monitor?', askedAt: 8 }
      ]
    })
    expect(screen.queryByText('Restart the daemon?')).not.toBeInTheDocument()
  })

  it('leaves skipped questions to the host after the answer is delivered', async () => {
    const settle = answerFirstOnly()
    await act(async () => settle(true))
    expect(dismissAsyncQuestions).not.toHaveBeenCalled()
    expect(screen.queryByText('Which monitor?')).not.toBeInTheDocument()
  })

  it('ends nothing when the answer was not delivered', () => {
    const settle = answerFirstOnly()
    act(() => settle(false))

    expect(dismissAsyncQuestions).not.toHaveBeenCalled()
    expect(screen.getByText('Which monitor?')).toBeInTheDocument()
  })

  it.each(['refused', 'missing', 'rejected'] as const)(
    'keeps a closed question retryable when dismissal is %s',
    async (outcome) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      if (outcome === 'missing') {
        delete testWindow.api
      } else if (outcome === 'rejected') {
        dismissAsyncQuestions.mockRejectedValue(new Error('Owner disconnected'))
      } else {
        dismissAsyncQuestions.mockResolvedValue(false)
      }
      renderCard()
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })))

      expect(screen.getByText('Restart the daemon?')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Restart/ })).toBeEnabled()
      expect(mocks.cancel).not.toHaveBeenCalled()
      expect(toastMessage).toHaveBeenCalledExactlyOnceWith(
        outcome === 'rejected'
          ? 'Could not confirm dismissal on the questions’ host. They remain available here.'
          : 'This host cannot dismiss these questions. They remain available to answer here.'
      )
      fireEvent.click(screen.getByRole('button', { name: /Restart/ }))
      expect(screen.getByText('Which monitor?')).toBeInTheDocument()
      warn.mockRestore()
    }
  )

  it('keeps the card visible and prevents repeated dismissal while the owner is answering', async () => {
    let settleDismissal!: (dismissed: boolean) => void
    dismissAsyncQuestions.mockImplementation(
      () => new Promise<boolean>((resolve) => (settleDismissal = resolve))
    )
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByText('Restart the daemon?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Restart/ })).toBeDisabled()
    expect(dismissAsyncQuestions).toHaveBeenCalledOnce()
    await act(async () => settleDismissal(true))
    expect(screen.queryByText('Restart the daemon?')).not.toBeInTheDocument()
  })

  it.each([true, false])(
    'ignores a stale dismissal result (%s) after a new ask arrives',
    async (dismissed) => {
      let settleDismissal!: (dismissed: boolean) => void
      dismissAsyncQuestions.mockImplementation(
        () => new Promise<boolean>((resolve) => (settleDismissal = resolve))
      )
      const rendered = renderCard()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      const replacement = JSON.parse(ASYNC_PROMPT)
      replacement.asyncQuestions[0].askedAt = 9
      storeState.agentStatusByPaneKey['tab-1:leaf-1'].interactivePrompt =
        JSON.stringify(replacement)
      rendered.rerender(cardElement())
      await act(async () => settleDismissal(dismissed))

      expect(screen.getByText('Restart the daemon?')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Restart/ })).toBeEnabled()
      expect(toastMessage).not.toHaveBeenCalled()
    }
  )

  it('does not hide the card after send authority was lost during dismissal', async () => {
    let settleDismissal!: (dismissed: boolean) => void
    dismissAsyncQuestions.mockImplementation(
      () => new Promise<boolean>((resolve) => (settleDismissal = resolve))
    )
    const rendered = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    rendered.rerender(cardElement(false))
    await act(async () => settleDismissal(true))
    rendered.rerender(cardElement())

    expect(screen.getByText('Restart the daemon?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Restart/ })).toBeEnabled()
  })

  it('ignores dismissal of an earlier mounted card', async () => {
    let settleDismissal!: (dismissed: boolean) => void
    dismissAsyncQuestions.mockImplementation(
      () => new Promise<boolean>((resolve) => (settleDismissal = resolve))
    )
    const rendered = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    rendered.unmount()
    renderCard()
    await act(async () => settleDismissal(true))

    expect(screen.getByText('Restart the daemon?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Restart/ })).toBeEnabled()
  })
})
