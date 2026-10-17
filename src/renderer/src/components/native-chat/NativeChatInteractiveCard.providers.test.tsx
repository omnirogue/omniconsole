// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../../../shared/agent-hook-listener'
import { createHookListenerState } from '../../../../shared/agent-hook-listener/listener-state'
import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  sendNativeChatAskAnswer: vi.fn(),
  sendNativeChatMessage: vi.fn(),
  storeState: { agentStatusByPaneKey: {} as Record<string, AgentStatusEntry> }
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
    { getState: () => mocks.storeState }
  )
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({ sendRuntimePtyInput: vi.fn() }))

vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: (terminalTabId: string) => ({ terminalTabId })
}))

vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatAskAnswer: (...args: unknown[]) => mocks.sendNativeChatAskAnswer(...args),
  sendNativeChatMessage: (...args: unknown[]) => mocks.sendNativeChatMessage(...args)
}))

import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const QUESTION = {
  questions: [
    {
      id: 'style',
      header: 'Style',
      question: 'Tabs or spaces?',
      multiSelect: false,
      options: [{ label: 'Tabs' }, { label: 'Spaces' }]
    }
  ]
}

function ProviderQuestion({ agent }: { agent: AgentType }): React.JSX.Element {
  // This is the same card + sender wiring used by NativeChatResolvedView.
  const send = useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', agent)
  return <NativeChatInteractiveCard paneKey={PANE_KEY} send={send} canSend transcriptSettled />
}

describe('native provider question click delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.storeState.agentStatusByPaneKey = {}
    const handle = { cancel: mocks.cancel, settleAfterMs: 500 }
    mocks.sendNativeChatAskAnswer.mockReturnValue(handle)
    mocks.sendNativeChatMessage.mockReturnValue(handle)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it.each([
    { agent: 'claude' as const, tool: 'AskUserQuestion' },
    { agent: 'codex' as const, tool: 'request_user_input' },
    { agent: 'grok' as const, tool: 'ask_user_question' },
    { agent: 'omp' as const, tool: 'ask' }
  ])('answers $agent $tool with one click through its native transport', ({ agent, tool }) => {
    // Start at real hook normalization, rather than assuming every provider
    // publishes the same renderer prompt or uses the same answer transport.
    const event = normalizeHookPayload(
      createHookListenerState(),
      agent,
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: agent === 'omp' ? 'tool_call' : 'PreToolUse',
          tool_name: tool,
          tool_input:
            agent === 'omp'
              ? {
                  questions: QUESTION.questions.map((question) => ({
                    id: question.id,
                    header: question.header,
                    question: question.question,
                    options: question.options,
                    multi: false,
                    recommended: 0
                  }))
                }
              : QUESTION
        }
      },
      'production'
    )
    expect(event?.payload.state).toBe(agent === 'omp' ? 'blocked' : 'waiting')
    if (!event) {
      throw new Error(`Missing ${agent} question hook`)
    }
    mocks.storeState.agentStatusByPaneKey[PANE_KEY] = {
      ...event.payload,
      paneKey: PANE_KEY,
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      stateHistory: []
    }

    render(<ProviderQuestion agent={agent} />)
    expect(screen.getByText('Tabs or spaces?')).toBeInTheDocument()
    expect(mocks.sendNativeChatAskAnswer).not.toHaveBeenCalled()
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Spaces/ }))
    fireEvent.click(screen.getByRole('button', { name: /Spaces/ }))
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()

    expect(mocks.sendNativeChatAskAnswer).toHaveBeenCalledExactlyOnceWith(
      { terminalTabId: 'tab-1' },
      'pty-1',
      agent === 'omp' || agent === 'grok'
        ? [{ raw: '\x1b[A' }, { raw: '\x1b[A' }, { raw: '\x1b[B' }, { raw: '\r' }]
        : [{ raw: '2' }],
      expect.any(Function)
    )
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
  })

  it('keeps native OMP multi choices editable until the user submits them', () => {
    const event = normalizeHookPayload(
      createHookListenerState(),
      'omp',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'tool_call',
          tool_name: 'ask',
          tool_input: {
            questions: [
              {
                id: 'styles',
                question: 'Allowed styles?',
                multi: true,
                options: [{ label: 'Tabs' }, { label: 'Spaces' }]
              }
            ]
          }
        }
      },
      'production'
    )
    expect(event?.payload.state).toBe('blocked')
    if (!event) {
      throw new Error('Missing OMP multi question hook')
    }
    mocks.storeState.agentStatusByPaneKey[PANE_KEY] = {
      ...event.payload,
      paneKey: PANE_KEY,
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      stateHistory: []
    }

    render(<ProviderQuestion agent="omp" />)
    fireEvent.click(screen.getByRole('button', { name: /Tabs/ }))
    fireEvent.click(screen.getByRole('button', { name: /Spaces/ }))
    expect(mocks.sendNativeChatAskAnswer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(mocks.sendNativeChatAskAnswer).toHaveBeenCalledExactlyOnceWith(
      { terminalTabId: 'tab-1' },
      'pty-1',
      [
        { raw: '\x1b[A' },
        { raw: '\x1b[A' },
        { raw: ' ' },
        { raw: '\x1b[B' },
        { raw: ' ' },
        { raw: '\r' }
      ],
      expect.any(Function)
    )
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
  })
})
