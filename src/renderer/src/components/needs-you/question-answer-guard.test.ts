import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AskPrompt } from '../native-chat/native-chat-interactive-prompt'
import type { NativeChatInteractiveSend } from '../native-chat/use-native-chat-interactive-send'
import {
  guardQuestionSend,
  questionPendingState,
  questionStillPending
} from './question-answer-guard'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const screen = (name: string): string =>
  readFileSync(
    join(__dirname, '../../../../shared/__fixtures__/option-only-ask-screens', `${name}.txt`),
    'utf8'
  )
const FRUIT: AskPrompt = {
  questions: [{ question: 'Which fruit?', multiSelect: false, options: [{ label: 'Apple' }] }]
}

function context(agentType: string, readScreen?: () => string | null) {
  const status = {
    paneKey: PANE_KEY,
    state: 'waiting',
    agentType,
    toolName: 'ask_user',
    interactivePrompt: JSON.stringify({
      optionOnlyAsk: { questions: [{ question: 'Which fruit?', options: [{ label: 'Apple' }] }] }
    }),
    stateStartedAt: 1,
    updatedAt: 1,
    prompt: '',
    stateHistory: []
  } as unknown as AgentStatusEntry
  return {
    paneKey: PANE_KEY,
    ptyId: 'pty-1',
    baseline: status,
    readStatus: () => status,
    readPtyId: () => 'pty-1',
    ...(readScreen ? { readScreen } : {})
  }
}

describe('questionStillPending for option-only agents', () => {
  it('needs the question’s own dialog on screen', () => {
    expect(
      questionStillPending(
        context('gemini', () => screen('gemini-single')),
        FRUIT
      )
    ).toBe(true)
    // Why: Gemini sends no hook on Esc, so only the screen says the dialog is gone.
    expect(
      questionStillPending(
        context('gemini', () => screen('gemini-after-esc')),
        FRUIT
      )
    ).toBe(false)
    expect(questionStillPending(context('gemini'), FRUIT)).toBe(false)
  })
})

describe('guardQuestionSend refusal notices', () => {
  const inner = (): NativeChatInteractiveSend => ({
    sendAnswer: vi.fn(() => ({ settleAfterMs: 1, waitsForVerifiedDelivery: true })),
    sendApproval: vi.fn(() => false),
    sendRaw: vi.fn(),
    cancelPending: vi.fn(),
    cancel: vi.fn()
  })

  it('says the dialog is not on screen, not "already answered", when only the screen differs', () => {
    const send = inner()
    const onStale = vi.fn()
    const onDeliverySettled = vi.fn()
    const guarded = guardQuestionSend(
      send,
      context('gemini', () => screen('gemini-after-esc')),
      onStale
    )
    guarded.sendAnswer(FRUIT, [{ indices: [0] }], onDeliverySettled)
    expect(onStale).not.toHaveBeenCalled()
    expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith(false, 'not-on-screen')
    expect(send.sendAnswer).not.toHaveBeenCalled()
  })

  it('keeps "already answered" for a question that is gone', () => {
    const send = inner()
    const onStale = vi.fn()
    const onDeliverySettled = vi.fn()
    const gone = {
      ...context('gemini', () => screen('gemini-single')),
      readStatus: () => undefined
    }
    guardQuestionSend(send, gone, onStale).sendAnswer(FRUIT, [{ indices: [0] }], onDeliverySettled)
    expect(onStale).toHaveBeenCalledOnce()
    expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith(false)
  })
})

const SHIP: AskPrompt = {
  questions: [
    {
      question: 'Who pushes the backend to production?',
      header: 'Who ships',
      multiSelect: false,
      options: [{ label: 'Uma ships it' }, { label: 'This session ships it' }]
    }
  ]
}
const SHIP_SELECTOR = [
  'Who ships',
  'Who pushes the backend to production?',
  '❯ 1. Uma ships it',
  '  2. This session ships it',
  'Enter to select · ↑/↓ to navigate · Esc to cancel'
].join('\n')

/** A Claude question main knows only from an old or restored report. */
function oldClaudeQuestion(readScreen?: () => string | null) {
  const status = {
    paneKey: PANE_KEY,
    state: 'waiting',
    agentType: 'claude',
    toolName: 'AskUserQuestion',
    interactivePrompt: JSON.stringify(SHIP),
    stateStartedAt: 1,
    updatedAt: 1,
    prompt: '',
    stateHistory: []
  } as unknown as AgentStatusEntry
  return {
    paneKey: PANE_KEY,
    ptyId: 'pty-1',
    baseline: status,
    readStatus: () => status,
    readPtyId: () => 'pty-1',
    confirmOnScreen: true,
    ...(readScreen ? { readScreen } : {})
  }
}

describe('questionPendingState for a question main knows only from an old report', () => {
  it('is pending only while its selector shows on screen', () => {
    expect(
      questionPendingState(
        oldClaudeQuestion(() => SHIP_SELECTOR),
        SHIP
      )
    ).toBe('pending')
    expect(
      questionPendingState(
        oldClaudeQuestion(() => '> '),
        SHIP
      )
    ).toBe('gone')
  })

  it('is gone when no screen can confirm it, so its answer goes as a message', () => {
    expect(questionPendingState(oldClaudeQuestion(), SHIP)).toBe('gone')
    const unreadable = oldClaudeQuestion(() => {
      throw new Error('detached')
    })
    expect(questionPendingState(unreadable, SHIP)).toBe('gone')
    expect(questionPendingState({ ...oldClaudeQuestion(), confirmOnScreen: false }, SHIP)).toBe(
      'pending'
    )
  })
})
