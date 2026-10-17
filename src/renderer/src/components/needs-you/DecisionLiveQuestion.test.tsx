// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { NativeChatInteractiveSend } from '../native-chat/use-native-chat-interactive-send'

const LEAF = '11111111-2222-4333-8444-555555555555'
const PANE = `tab-1:${LEAF}`
const STATUS = {
  state: 'waiting',
  agentType: 'claude',
  interactivePrompt: JSON.stringify({
    questions: [
      {
        question: 'Which fruit?',
        multiSelect: false,
        options: [{ label: 'Apple' }, { label: 'Banana' }]
      }
    ]
  }),
  toolName: 'AskUserQuestion',
  stateStartedAt: 1_000,
  terminalHandle: 'term-1',
  connectionId: null
} as unknown as AgentStatusEntry

const mocks = vi.hoisted(() => ({
  state: {} as {
    agentStatusByPaneKey: Record<string, unknown>
    terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId: Record<string, string> }>
  },
  sendAnswer: vi.fn(),
  toast: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mocks.state), {
    getState: () => mocks.state
  })
}))
vi.mock('sonner', () => ({ toast: { message: mocks.toast, error: mocks.toast } }))
vi.mock('../native-chat/use-native-chat-interactive-send', () => ({
  useNativeChatInteractiveSend: (): NativeChatInteractiveSend => ({
    sendAnswer: mocks.sendAnswer,
    sendApproval: vi.fn(),
    sendRaw: vi.fn(),
    cancelPending: vi.fn(),
    cancel: vi.fn()
  })
}))
vi.mock('../native-chat/use-native-chat-can-send', () => ({ useNativeChatCanSend: () => true }))

import { DecisionLiveQuestion } from './DecisionLiveQuestion'

beforeEach(() => {
  mocks.state = {
    agentStatusByPaneKey: { [PANE]: STATUS },
    terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF]: 'pty-1' } } }
  }
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('says why nothing was sent when the terminal refuses the answer, and keeps the options', () => {
  let settle: Parameters<NativeChatInteractiveSend['sendAnswer']>[2]
  mocks.sendAnswer.mockImplementation((_prompt, _selections, onDeliverySettled) => {
    settle = onDeliverySettled
    return { settleAfterMs: 500, waitsForVerifiedDelivery: true }
  })
  const onAnswered = vi.fn()
  render(
    <DecisionLiveQuestion
      paneKey={PANE}
      tabId="tab-1"
      ptyId="pty-1"
      baseline={STATUS}
      onAnswered={onAnswered}
    />
  )

  fireEvent.click(screen.getByRole('button', { name: /Banana/ }))
  act(() => settle?.(false, 'not-delivered'))

  expect(mocks.toast).toHaveBeenCalledExactlyOnceWith(
    'The terminal didn’t take the answer. Nothing was sent; open the session to answer it.'
  )
  expect(screen.getByRole('button', { name: /Banana/ })).toBeTruthy()
  expect(onAnswered).not.toHaveBeenCalled()
})
