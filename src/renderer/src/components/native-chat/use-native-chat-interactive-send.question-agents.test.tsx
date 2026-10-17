// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  inferQuestionAnswered: vi.fn(() => Promise.resolve(true)),
  sendNativeChatAskAnswer: vi.fn(),
  sendNativeChatMessage: vi.fn(),
  storeState: { agentStatusByPaneKey: {} as Record<string, unknown> }
}))

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

vi.mock('../../store', () => ({ useAppStore: { getState: () => mocks.storeState } }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({ sendRuntimePtyInput: vi.fn() }))
vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: (terminalTabId: string) => ({ terminalTabId })
}))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatAskAnswer: (...args: unknown[]) => mocks.sendNativeChatAskAnswer(...args),
  sendNativeChatMessage: (...args: unknown[]) => mocks.sendNativeChatMessage(...args)
}))

import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'
import type { AskAnswerSelection, AskPrompt } from './native-chat-interactive-prompt'

// Raw captures of the real TUIs, shared with the detector's tests.
const screen = (name: string): string =>
  readFileSync(
    join(__dirname, '../../../../shared/__fixtures__/option-only-ask-screens', `${name}.txt`),
    'utf8'
  )

const options = (...labels: string[]) => labels.map((label) => ({ label }))
const FRUIT_OCEAN: AskPrompt = {
  questions: [
    {
      question: 'Which fruit?',
      header: 'Fruit',
      multiSelect: false,
      options: options('Apple', 'Banana', 'Cherry')
    },
    {
      question: 'Which ocean?',
      header: 'Ocean',
      multiSelect: false,
      options: options('Atlantic', 'Pacific', 'Indian')
    }
  ]
}
const FRUIT: AskPrompt = { questions: [FRUIT_OCEAN.questions[0]!] }
const MULTI: AskPrompt = {
  questions: [{ question: 'Which fruit?', multiSelect: true, options: options('Apple', 'Pear') }]
}

function send(
  agent: string,
  prompt: AskPrompt,
  selections: AskAnswerSelection[],
  readScreen?: () => string | null
) {
  const onDeliverySettled = vi.fn()
  const { result } = renderHook(() =>
    useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-1', agent, readScreen)
  )
  let outcome: { settleAfterMs: number } | undefined
  act(() => {
    outcome = result.current.sendAnswer(prompt, selections, onDeliverySettled)
  })
  return { outcome, onDeliverySettled }
}

function expectNothingSent(result: ReturnType<typeof send>, refusal?: 'not-on-screen'): void {
  expect(result.outcome?.settleAfterMs).toBe(0)
  if (refusal) {
    expect(result.onDeliverySettled).toHaveBeenCalledExactlyOnceWith(false, refusal)
  } else {
    expect(result.onDeliverySettled).toHaveBeenCalledExactlyOnceWith(false)
  }
  expect(mocks.sendNativeChatAskAnswer).not.toHaveBeenCalled()
  expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
}

describe('question answers for Gemini, Qwen Code and Hermes panes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeState = { agentStatusByPaneKey: {} }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { agentStatus: { inferQuestionAnswered: mocks.inferQuestionAnswered } }
    })
    mocks.sendNativeChatAskAnswer.mockReturnValue({ cancel: vi.fn(), settleAfterMs: 1500 })
  })

  it.each([
    ['gemini', 'gemini-batch', ['3', '1', '\r']],
    ['qwen-code', 'qwen-batch', ['3', '1', '\r']],
    ['hermes', 'hermes-batch', ['3', '1']]
  ])('sends %s its own keys, each gated on its dialog step', async (agent, fixture, keys) => {
    send(agent, FRUIT_OCEAN, [{ indices: [2] }, { indices: [0] }], () => screen(fixture))
    const [, , groups, , beforeGroup] = mocks.sendNativeChatAskAnswer.mock.calls[0]!
    expect(groups.map((group: { raw: string }) => group.raw)).toEqual(keys)
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
    // The captured screen shows question 1, so the first key may go.
    await expect(beforeGroup(groups[0])).resolves.toBe(true)
  })

  it.each([
    ['gemini', 'gemini-after-esc'],
    ['qwen-code', 'qwen-after-esc'],
    ['hermes', 'hermes-after-esc']
  ])('%s: a question cancelled in the terminal gets no keys (%s)', (agent, fixture) => {
    // Why: Gemini and Qwen send no hook on Esc, so the card is still live here.
    expectNothingSent(
      send(agent, FRUIT, [{ indices: [1] }], () => screen(fixture)),
      'not-on-screen'
    )
  })

  it('Qwen: another tool’s confirmation in front of the question gets no keys', () => {
    expectNothingSent(
      send('qwen-code', FRUIT, [{ indices: [1] }], () => screen('qwen-shell-approval')),
      'not-on-screen'
    )
  })

  it('refuses without a screen to verify', () => {
    expectNothingSent(send('gemini', FRUIT, [{ indices: [1] }]), 'not-on-screen')
    expectNothingSent(
      send('hermes', FRUIT, [{ indices: [1] }], () => null),
      'not-on-screen'
    )
  })

  it.each<[string, AskPrompt, AskAnswerSelection[], string]>([
    ['gemini', MULTI, [{ indices: [0] }], 'gemini-single'],
    ['qwen-code', FRUIT_OCEAN, [{ indices: [1] }, { indices: [] }], 'qwen-batch'],
    ['hermes', FRUIT_OCEAN, [{ indices: [0], other: 'Kiwi' }, { indices: [0] }], 'hermes-batch']
  ])('refuses a %s answer its builder refuses', (agent, prompt, selections, fixture) => {
    expectNothingSent(send(agent, prompt, selections, () => screen(fixture)))
  })
})
