// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatInteractiveSend } from '../native-chat/use-native-chat-interactive-send'

const QUESTION = JSON.stringify({
  questions: [
    {
      question: 'Tabs or spaces?',
      multiSelect: false,
      options: [{ label: 'Tabs' }, { label: 'Spaces' }]
    }
  ]
})
const APPROVAL = JSON.stringify({ approval: { tool: 'Bash', summary: 'ls -la' } })

const mocks = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
  sendAnswer: vi.fn(),
  sendApproval: vi.fn(),
  sendRaw: vi.fn(),
  cancelPending: vi.fn(),
  cancel: vi.fn(),
  sendHook: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ agentStatusByPaneKey: { 'tab-1:leaf-1': mocks.status } })
}))
vi.mock('../native-chat/use-native-chat-interactive-send', () => ({
  useNativeChatInteractiveSend: (...args: unknown[]): NativeChatInteractiveSend => {
    mocks.sendHook(...args)
    return {
      sendAnswer: mocks.sendAnswer,
      sendApproval: mocks.sendApproval,
      sendRaw: mocks.sendRaw,
      cancelPending: mocks.cancelPending,
      cancel: mocks.cancel
    }
  }
}))
vi.mock('../native-chat/use-native-chat-can-send', () => ({
  useNativeChatCanSend: () => true
}))
vi.mock('../next-steps/NextStepsTerminalPill', () => ({
  NextStepsTerminalPill: ({ suppressed }: { suppressed?: boolean }) => (
    <p data-testid="next-steps">{suppressed ? 'next steps hidden' : 'next steps shown'}</p>
  )
}))

import { TerminalPaneAnswerOverlay } from './TerminalPaneAnswerOverlay'

const readScreen = (): string | null => null
function overlay(ptyId: string | null = 'pty-1'): React.JSX.Element {
  return (
    <TerminalPaneAnswerOverlay
      worktreeId="wt"
      tabId="tab-1"
      paneKey="tab-1:leaf-1"
      ptyId={ptyId}
      readTerminalScreen={readScreen}
    />
  )
}

beforeEach(() => {
  mocks.status = {
    state: 'waiting',
    agentType: 'claude',
    interactivePrompt: QUESTION,
    toolName: 'AskUserQuestion'
  }
  mocks.sendAnswer.mockReturnValue({ settleAfterMs: 500, waitsForVerifiedDelivery: true })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('shows the agent’s question in the terminal corner, over the next steps', async () => {
  render(overlay())
  expect(screen.getByText('Tabs or spaces?')).toBeTruthy()
  await waitFor(() =>
    expect(screen.getByTestId('next-steps').textContent).toBe('next steps hidden')
  )
  // The chat view's own send path, for this pane's live PTY.
  expect(mocks.sendHook).toHaveBeenCalledWith(
    'tab-1',
    'tab-1:leaf-1',
    'pty-1',
    'claude',
    readScreen
  )
})

it('answers with a click, through the same keystroke path as the chat view', () => {
  render(overlay())
  fireEvent.click(screen.getByRole('button', { name: /Spaces/ }))
  expect(mocks.sendAnswer).toHaveBeenCalledTimes(1)
  expect(mocks.sendAnswer.mock.calls[0]![1]).toEqual([{ indices: [1], other: '' }])
})

it('leaves a tool approval to the terminal’s own prompt', () => {
  mocks.status = { ...mocks.status, interactivePrompt: APPROVAL, toolName: 'Bash' }
  render(overlay())
  expect(screen.queryByText('Tabs or spaces?')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
  expect(screen.getByTestId('next-steps').textContent).toBe('next steps shown')
})

it('shows nothing without a live PTY to answer into', () => {
  render(overlay(null))
  expect(screen.queryByText('Tabs or spaces?')).toBeNull()
  expect(screen.getByTestId('next-steps').textContent).toBe('next steps shown')
})

it('gives the corner back to the next steps once the question is gone', async () => {
  const view = render(overlay())
  await waitFor(() =>
    expect(screen.getByTestId('next-steps').textContent).toBe('next steps hidden')
  )
  mocks.status = { state: 'done', agentType: 'claude' }
  view.rerender(overlay())
  await waitFor(() => expect(screen.getByTestId('next-steps').textContent).toBe('next steps shown'))
  expect(screen.queryByText('Tabs or spaces?')).toBeNull()
})
