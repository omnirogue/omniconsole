// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatInteractiveSend } from '../native-chat/use-native-chat-interactive-send'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'

const LEAF = '11111111-2222-4333-8444-555555555555'
const PANE = `tab-1:${LEAF}`
const ask = (multiSelect = false) =>
  JSON.stringify({
    questions: [
      {
        question: 'Which fruits?',
        multiSelect,
        options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }]
      }
    ]
  })

const mocks = vi.hoisted(() => ({
  state: {} as {
    agentStatusByPaneKey: Record<string, Record<string, unknown>>
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

import { NeedsYouQuestionRow } from './NeedsYouQuestionRow'
import { useRegisterTerminalScreenReader } from '../terminal-pane/terminal-screen-readers'

function status(prompt = ask()): Record<string, unknown> {
  return {
    state: 'waiting',
    agentType: 'claude',
    interactivePrompt: prompt,
    toolName: 'AskUserQuestion',
    stateStartedAt: 1_000,
    terminalHandle: 'term-1',
    connectionId: null
  }
}

beforeEach(() => {
  mocks.state = {
    agentStatusByPaneKey: { [PANE]: status() },
    terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF]: 'pty-1' } } }
  }
  mocks.sendAnswer.mockReturnValue({ settleAfterMs: 0, waitsForVerifiedDelivery: false })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function option(label: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(label) })
}

function action(text: string): HTMLElement {
  return [...document.querySelectorAll<HTMLElement>('button')].find(
    (button) => button.textContent?.trim() === text
  )!
}

it('shows the session and its question, and answers one option exactly once', () => {
  render(<NeedsYouQuestionRow paneKey={PANE} title="Checkout fix" />)
  expect(screen.getByText('Checkout fix')).toBeTruthy()
  expect(screen.getByText('Which fruits?')).toBeTruthy()
  fireEvent.click(option('Banana'))
  expect(mocks.sendAnswer).toHaveBeenCalledTimes(1)
  expect(mocks.sendAnswer.mock.calls[0]![1]).toEqual([{ indices: [1], other: '' }])
})

it('sends several ticked options with Submit, and a typed “Other” answer', () => {
  mocks.state.agentStatusByPaneKey[PANE] = status(ask(true))
  render(<NeedsYouQuestionRow paneKey={PANE} title="Checkout fix" />)
  fireEvent.click(option('Cherry'))
  fireEvent.click(option('Apple'))
  expect(mocks.sendAnswer).not.toHaveBeenCalled()
  fireEvent.click(action('Submit'))
  expect(mocks.sendAnswer.mock.calls[0]![1]).toEqual([{ indices: [0, 2], other: '' }])

  cleanup()
  mocks.sendAnswer.mockClear()
  mocks.state.agentStatusByPaneKey[PANE] = status(ask())
  render(<NeedsYouQuestionRow paneKey={PANE} title="Checkout fix" />)
  const other = screen.getByPlaceholderText('Type your answer')
  fireEvent.change(other, { target: { value: 'Mango' } })
  fireEvent.click(action('Submit'))
  expect(mocks.sendAnswer.mock.calls[0]![1]).toEqual([{ indices: [], other: 'Mango' }])
})

it('sends nothing when the question was answered elsewhere just before the click', () => {
  render(<NeedsYouQuestionRow paneKey={PANE} title="Checkout fix" />)
  // Answered in the terminal: the pane's status moved on after the row was drawn.
  mocks.state.agentStatusByPaneKey[PANE] = {
    ...status(),
    state: 'working',
    interactivePrompt: undefined
  }
  fireEvent.click(option('Banana'))
  expect(mocks.sendAnswer).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenCalledWith(
    'That question was already answered, or the session moved on. Nothing was sent.'
  )
})

it('sends nothing when Claude’s selector is no longer on its screen', () => {
  function Screen(): null {
    useRegisterTerminalScreenReader(PANE, () => 'Done. The export now streams.')
    return null
  }
  render(
    <>
      <Screen />
      <NeedsYouQuestionRow paneKey={PANE} title="Checkout fix" />
    </>
  )
  fireEvent.click(option('Banana'))
  expect(mocks.sendAnswer).not.toHaveBeenCalled()
})

it('says it can’t answer from here when the session’s terminal isn’t reachable', () => {
  mocks.state.terminalLayoutsByTabId = {}
  render(<NeedsYouQuestionRow paneKey={PANE} title="Remote build" />)
  expect(screen.getByText('Which fruits?')).toBeTruthy()
  expect(document.querySelector('[data-needs-you-unreachable]')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Banana/ })).toBeNull()
})

it('answers a Codex async question on an SSH session, and sends one another OmniConsole runs to its terminal', () => {
  mocks.state.agentStatusByPaneKey[PANE] = {
    ...status(
      JSON.stringify({
        delivery: 'async',
        asyncQuestions: [
          { question: 'Which fruits?', multiSelect: false, options: [{ label: 'Apple' }] }
        ]
      })
    ),
    state: 'done',
    agentType: 'codex',
    connectionId: 'ssh-1'
  }
  const ssh = render(<NeedsYouQuestionRow paneKey={PANE} title="SSH build" />)
  expect(screen.getByRole('button', { name: /Apple/ })).toBeTruthy()
  ssh.unmount()
  mocks.state.terminalLayoutsByTabId = {
    'tab-1': { ptyIdsByLeafId: { [LEAF]: toRemoteRuntimePtyId('term_9', 'env-1') } }
  }
  render(<NeedsYouQuestionRow paneKey={PANE} title="Remote build" />)
  expect(screen.getByText('Which fruits?')).toBeTruthy()
  expect(document.querySelector('[data-needs-you-owner-question]')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Apple/ })).toBeNull()
})

it('draws nothing once the pane is no longer waiting on a question', () => {
  mocks.state.agentStatusByPaneKey[PANE] = { ...status(), state: 'working' }
  const view = render(<NeedsYouQuestionRow paneKey={PANE} title="Checkout fix" />)
  expect(view.container.innerHTML).toBe('')
})
