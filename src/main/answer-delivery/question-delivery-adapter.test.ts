import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaimableDelivery } from '../work-delivery/work-delivery-kind'
import { WorkDeliveryHold } from '../work-delivery/work-delivery-claimer-types'
import {
  beginCardTyping,
  cardTyped,
  cardTypingUncertain,
  endCardTyping,
  resetAnswerHandoverForTests
} from './answer-delivery-handover'
import {
  deliverQuestionLive,
  questionAnswerOf,
  type QuestionLiveDeps
} from './question-delivery-adapter'

vi.mock('../session-questions/omnios-question-apply', () => ({
  applyOmniosAnswer: vi.fn(),
  liveDecisionFor: vi.fn()
}))
vi.mock('./answer-delivery-target', () => ({
  organizationFields: vi.fn(async () => ({})),
  restoreForAnswer: vi.fn(() => vi.fn())
}))

const KEY = 'question:12:a1'

function delivery(context: Record<string, unknown> = {}): ClaimableDelivery {
  return {
    key: KEY,
    kind: 'question',
    workItem: 'question:12',
    text: 'Sal answered: Ship it? → Yes',
    context: {
      questionId: 12,
      fingerprint: 'f'.repeat(64),
      paneKey: 'tab-1:leaf-1',
      sessionId: 'sess-1',
      toolUseId: 'toolu_1',
      answers: { 'Ship it?': 'Yes', bad: 3 },
      skipped: false,
      ...context
    }
  } as unknown as ClaimableDelivery
}

beforeEach(() => resetAnswerHandoverForTests())

describe('questionAnswerOf', () => {
  it('rebuilds the answer the Questions round would type, dropping non-text answers', () => {
    expect(questionAnswerOf(delivery())).toEqual({
      id: '12',
      fingerprint: 'f'.repeat(64),
      paneKey: 'tab-1:leaf-1',
      sessionId: 'sess-1',
      toolUseId: 'toolu_1',
      answers: { 'Ship it?': 'Yes' },
      skipped: false
    })
  })

  it('is null without a question id or fingerprint', () => {
    expect(questionAnswerOf(delivery({ questionId: undefined }))).toBeNull()
    expect(questionAnswerOf(delivery({ fingerprint: '' }))).toBeNull()
  })
})

describe('deliverQuestionLive', () => {
  const deps = (
    apply: QuestionLiveDeps['apply'] = vi.fn(async () => ({ delivered: true }) as const),
    pending = true
  ) => ({ isPending: vi.fn(() => pending), apply })

  it('types into the open card once, then only follows it', async () => {
    const d = deps()
    expect(await deliverQuestionLive(d, delivery())).toBe('typed')
    expect(cardTyped(KEY)).toBe(true)
    expect(await deliverQuestionLive(d, delivery())).toBe('typed')
    expect(d.apply).toHaveBeenCalledTimes(1)
  })

  it('leaves an ended card to the queue', async () => {
    const d = deps(vi.fn(), false)
    expect(await deliverQuestionLive(d, delivery())).toBe('not_open')
    expect(d.apply).not.toHaveBeenCalled()
    const ended = deps(
      vi.fn(async () => ({
        delivered: false as const,
        error: 'The session is no longer waiting on this question; nothing was typed.'
      }))
    )
    expect(await deliverQuestionLive(ended, delivery())).toBe('not_open')
  })

  it('holds busy while the Questions round is typing the same answer', async () => {
    beginCardTyping(KEY)
    const d = deps()
    await expect(deliverQuestionLive(d, delivery())).rejects.toMatchObject({ reason: 'busy' })
    expect(d.apply).not.toHaveBeenCalled()
  })

  it('follows an answer the Questions round already typed, without typing it', async () => {
    beginCardTyping(KEY)
    endCardTyping(KEY, 'typed')
    const d = deps()
    expect(await deliverQuestionLive(d, delivery())).toBe('typed')
    expect(d.apply).not.toHaveBeenCalled()
  })

  it('never types again after an unconfirmed attempt, on either path', async () => {
    const d = deps(
      vi.fn(async () => ({
        delivered: false as const,
        error: 'The desktop window did not confirm the answer; check the session.'
      }))
    )
    const first = deliverQuestionLive(d, delivery())
    await expect(first).rejects.toThrow('did not confirm')
    await expect(first).rejects.not.toBeInstanceOf(WorkDeliveryHold)
    expect(cardTypingUncertain(KEY)).toBe(true)
    await expect(deliverQuestionLive(d, delivery())).rejects.toThrow('cannot be confirmed')
    expect(d.apply).toHaveBeenCalledTimes(1)
  })

  it('marks a thrown apply as unconfirmed', async () => {
    const d = deps(
      vi.fn(async () => {
        throw new Error('relay down')
      })
    )
    await expect(deliverQuestionLive(d, delivery())).rejects.toThrow('relay down')
    expect(cardTypingUncertain(KEY)).toBe(true)
  })

  it('holds a clean refusal as an error it may retry', async () => {
    const d = deps(
      vi.fn(async () => ({
        delivered: false as const,
        error: 'This OmniConsole window cannot type OmniOS answers yet; reload it and retry.'
      }))
    )
    await expect(deliverQuestionLive(d, delivery())).rejects.toMatchObject({ reason: 'error' })
    expect(cardTypingUncertain(KEY)).toBe(false)
  })
})
