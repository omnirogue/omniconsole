// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'

const prompt = (id: string) =>
  JSON.stringify({
    ompApproval: { tool: 'bash', toolCallId: id, summary: 'cp source.txt receipt.txt' }
  })
const storeState = {
  agentStatusByPaneKey: {
    pane: {
      interactivePrompt: prompt('call-a'),
      toolName: 'bash',
      agentType: 'omp',
      state: 'blocked'
    }
  }
}
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'

const send = {
  sendAnswer: vi.fn<NativeChatInteractiveSend['sendAnswer']>(),
  sendApproval: vi.fn<NativeChatInteractiveSend['sendApproval']>(),
  sendRaw: vi.fn(),
  cancelPending: vi.fn(),
  cancel: vi.fn()
}
const onShowing = vi.fn()
const openTerminal = vi.fn()
function card(canSend = true) {
  return (
    <NativeChatInteractiveCard
      paneKey="pane"
      send={send}
      canSend={canSend}
      transcriptSettled
      onShowingQuestionChange={onShowing}
      onSwitchToTerminal={openTerminal}
    />
  )
}
function choose(name = 'Allow') {
  fireEvent.click(screen.getByRole('button', { name }))
}

describe('NativeChatInteractiveCard approvals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    send.sendApproval.mockReturnValue(true)
    storeState.agentStatusByPaneKey.pane.interactivePrompt = prompt('call-a')
    storeState.agentStatusByPaneKey.pane.agentType = 'omp'
    storeState.agentStatusByPaneKey.pane.state = 'blocked'
  })
  afterEach(() => {
    cleanup()
  })

  it('shows the command, hides the composer, and waits for verified delivery', () => {
    render(card())
    expect(screen.getByText('cp source.txt receipt.txt')).toBeInTheDocument()
    expect(onShowing).toHaveBeenLastCalledWith(true)
    choose()
    expect(send.sendApproval).toHaveBeenCalledWith(
      prompt('call-a'),
      'approve',
      expect.any(Function)
    )
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Sending…')
    choose('Deny')
    expect(send.sendApproval).toHaveBeenCalledTimes(1)
    expect(send.sendRaw).not.toHaveBeenCalled()
    act(() => send.sendApproval.mock.calls[0]![2](true))
    expect(screen.queryByText('Allow bash?')).not.toBeInTheDocument()
    expect(onShowing).toHaveBeenLastCalledWith(false)
  })

  it('keeps a rejected approval visible and retryable', () => {
    render(card())
    choose('Deny')
    expect(send.sendApproval).toHaveBeenCalledWith(prompt('call-a'), 'deny', expect.any(Function))
    act(() => send.sendApproval.mock.calls[0]![2](false))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not confirm delivery.')
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
    choose()
    expect(send.sendApproval).toHaveBeenCalledTimes(2)
  })

  it('keeps the card actionable if its PTY disappeared before the click', () => {
    send.sendApproval.mockReturnValue(false)
    render(card())
    choose()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
    expect(screen.getByText('Allow bash?')).toBeInTheDocument()
  })

  it('ignores an old acknowledgement after a replacement approval starts sending', () => {
    const view = render(card())
    choose()
    const oldSettled = send.sendApproval.mock.calls[0]![2]
    storeState.agentStatusByPaneKey.pane.interactivePrompt = prompt('call-b')
    view.rerender(card())
    expect(send.cancelPending).toHaveBeenCalledOnce()
    choose('Deny')
    act(() => oldSettled(true))
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
    act(() => send.sendApproval.mock.calls[1]![2](false))
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled()
  })

  it('shows a new tool-call id even when its command matches a dismissed request', () => {
    const view = render(card())
    choose()
    act(() => send.sendApproval.mock.calls[0]![2](true))
    storeState.agentStatusByPaneKey.pane.interactivePrompt = prompt('call-b')
    view.rerender(card())
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
  })

  it('cancels pending writes and ignores settlement after send authority is lost', () => {
    const view = render(card())
    choose()
    const settled = send.sendApproval.mock.calls[0]![2]
    view.rerender(card(false))
    expect(send.cancelPending).toHaveBeenCalledOnce()
    act(() => settled(true))
    view.rerender(card())
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
  })

  it('cancels pending approval writes on unmount', () => {
    const view = render(card())
    choose()
    view.unmount()
    expect(send.cancelPending).toHaveBeenCalledOnce()
  })

  it('does not carry a failed delivery into a new occurrence of the same prompt', () => {
    const view = render(card())
    choose()
    act(() => send.sendApproval.mock.calls[0]![2](false))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    storeState.agentStatusByPaneKey.pane.interactivePrompt = ''
    view.rerender(card())
    storeState.agentStatusByPaneKey.pane.interactivePrompt = prompt('call-a')
    view.rerender(card())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled()
  })

  it('keeps an unidentified old-hook decision actionable without sending approval keys', () => {
    storeState.agentStatusByPaneKey.pane.interactivePrompt = ''
    const view = render(card())
    expect(screen.getByRole('status')).toHaveTextContent('waiting for your decision')
    expect(onShowing).toHaveBeenLastCalledWith(true)
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
    choose('Open Terminal')
    expect(openTerminal).toHaveBeenCalledOnce()
    expect(send.sendApproval).not.toHaveBeenCalled()
    expect(send.sendRaw).not.toHaveBeenCalled()
    expect(send.cancel).not.toHaveBeenCalled()

    storeState.agentStatusByPaneKey.pane.state = 'working'
    view.rerender(card())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(onShowing).toHaveBeenLastCalledWith(false)
  })

  it('replaces the terminal notice when the host provides an identified approval', () => {
    storeState.agentStatusByPaneKey.pane.interactivePrompt = ''
    const view = render(card())
    storeState.agentStatusByPaneKey.pane.interactivePrompt = prompt('call-b')
    view.rerender(card())
    expect(screen.queryByRole('button', { name: 'Open Terminal' })).not.toBeInTheDocument()
    choose()
    expect(send.sendApproval).toHaveBeenCalledWith(
      prompt('call-b'),
      'approve',
      expect.any(Function)
    )
  })

  it('does not infer an OMP decision from another provider or lost send authority', () => {
    storeState.agentStatusByPaneKey.pane.interactivePrompt = ''
    storeState.agentStatusByPaneKey.pane.agentType = 'claude'
    const view = render(card())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    storeState.agentStatusByPaneKey.pane.agentType = 'omp'
    view.rerender(card(false))
    expect(screen.queryByRole('button', { name: 'Open Terminal' })).not.toBeInTheDocument()
    expect(onShowing).toHaveBeenLastCalledWith(false)
  })
})
