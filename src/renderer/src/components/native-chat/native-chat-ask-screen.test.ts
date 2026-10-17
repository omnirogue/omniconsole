import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_ASK_CLOSE_CHECK_MS,
  CLAUDE_ASK_CLOSE_CHECKS,
  isClaudeAskSelectorOpen,
  waitForClaudeAskSelectorClosed
} from './native-chat-ask-screen'
import type { AskPrompt } from './native-chat-interactive-prompt'

const PROMPT: AskPrompt = {
  questions: [
    {
      question: 'With the Routines tab gone, where should routines live in the Conversations list?',
      header: 'Placement',
      multiSelect: false,
      options: [{ label: 'Inline, clock icon (Recommended)' }, { label: 'Own "Routines" group' }]
    },
    {
      question:
        "Routines only run while the IDE is open — the scheduler lives in the app's main process. How far should I go?",
      header: 'Scheduler scope',
      multiSelect: false,
      options: [
        { label: 'Fix the in-app bugs (Recommended)' },
        { label: 'Also run without the app' }
      ]
    }
  ]
}

// The stuck pane from the incident: question 1 committed, question 2 still waiting.
const STUCK_SCREEN = [
  '←  ☒ Placement  ☐ Scheduler scope  ✔ Submit  →',
  "│ Routines only run while the IDE is open — the scheduler lives in the app's main process. How far should I go?",
  '❯ 1. Fix the in-app bugs          ┌──────────────────────┐',
  '    (Recommended)                 │ FIXES                │',
  '  2. Also run without the app     └──────────────────────┘',
  '                                  Notes: press n to add notes',
  '  Chat about this',
  'Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel'
].join('\n')

const REVIEW_SCREEN = [
  '←  ☒ Placement  ☒ Scheduler scope  ✔ Submit  →',
  'Review your answers',
  'Ready to submit your answers?',
  '❯ 1. Submit answers',
  '  2. Cancel',
  'Enter to select · Esc to cancel'
].join('\n')

const ANSWERED_SCREEN = [
  '⏺ User answered Claude’s questions:',
  '  ⎿  · With the Routines tab gone, where should routines live? → Inline',
  '✳ Thinking… (esc to interrupt)'
].join('\n')

describe('isClaudeAskSelectorOpen', () => {
  it('sees the selector still waiting on a question of this prompt', () => {
    expect(isClaudeAskSelectorOpen(STUCK_SCREEN, PROMPT)).toBe(true)
  })

  it('sees the unsubmitted review step', () => {
    expect(isClaudeAskSelectorOpen(REVIEW_SCREEN, PROMPT)).toBe(true)
  })

  it('treats the answered transcript as closed', () => {
    expect(isClaudeAskSelectorOpen(ANSWERED_SCREEN, PROMPT)).toBe(false)
  })

  it('ignores a selector that belongs to a different prompt', () => {
    const other: AskPrompt = {
      questions: [{ question: 'Deploy now?', header: 'Deploy', multiSelect: false, options: [] }]
    }
    expect(isClaudeAskSelectorOpen(STUCK_SCREEN, other)).toBe(false)
  })

  it('treats an unreadable screen as closed', () => {
    expect(isClaudeAskSelectorOpen(null, PROMPT)).toBe(false)
  })
})

describe('waitForClaudeAskSelectorClosed', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reports not delivered when the selector never leaves the screen', () => {
    const onResult = vi.fn()
    waitForClaudeAskSelectorClosed({
      prompt: PROMPT,
      readScreen: () => STUCK_SCREEN,
      isCancelled: () => false,
      onResult
    })
    vi.advanceTimersByTime(CLAUDE_ASK_CLOSE_CHECK_MS * (CLAUDE_ASK_CLOSE_CHECKS - 1))
    expect(onResult).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('reports delivered once the selector closes', () => {
    const onResult = vi.fn()
    const screens = [STUCK_SCREEN, ANSWERED_SCREEN]
    waitForClaudeAskSelectorClosed({
      prompt: PROMPT,
      readScreen: () => screens.shift() ?? ANSWERED_SCREEN,
      isCancelled: () => false,
      onResult
    })
    expect(onResult).not.toHaveBeenCalled()
    vi.advanceTimersByTime(CLAUDE_ASK_CLOSE_CHECK_MS)
    expect(onResult).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('keeps the accepted write when there is no screen to read', () => {
    const onResult = vi.fn()
    waitForClaudeAskSelectorClosed({
      prompt: PROMPT,
      readScreen: undefined,
      isCancelled: () => false,
      onResult
    })
    expect(onResult).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('stops checking once cancelled', () => {
    const onResult = vi.fn()
    const stop = waitForClaudeAskSelectorClosed({
      prompt: PROMPT,
      readScreen: () => STUCK_SCREEN,
      isCancelled: () => false,
      onResult
    })
    stop()
    vi.advanceTimersByTime(CLAUDE_ASK_CLOSE_CHECK_MS * CLAUDE_ASK_CLOSE_CHECKS)
    expect(onResult).not.toHaveBeenCalled()
  })
})
