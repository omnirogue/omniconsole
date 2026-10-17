// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { NextStepSuggestionSet } from '../../../../shared/next-step-suggestions'
import { pendingNextStepCounts } from './next-steps-pending-store'
import { nextStepPromptVisibility } from './next-steps-prompt-disclosure'
import { resolveNextStepsTrayView } from './next-steps-tray-model'

const conversation = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const set = (over: Partial<NextStepSuggestionSet>): NextStepSuggestionSet => ({
  id: 'set',
  conversation,
  worktreeId: 'wt',
  turnKey: 't1',
  origin: 'ai',
  createdAt: 10,
  status: 'pending',
  suggestions: [
    { id: 's1', title: 'Test it', prompt: 'Run the tests.', risk: 'safe', kind: 'verify' }
  ],
  ...over
})
const reply = { messageId: 'm', timestamp: 20, suggestions: [] }
const current = (over: object) => ({
  turnKey: 't1',
  answered: false,
  turnObserved: true,
  revision: 1,
  ...over
})

describe('resolveNextStepsTrayView', () => {
  const parsed = set({ id: 'parsed', origin: 'parsed', messageId: 'm' })
  it('hides everything once the host says the turn was answered', () => {
    const view = resolveNextStepsTrayView(
      current({ ai: set({ status: 'superseded' }), parsed, answered: true }),
      reply
    )
    expect(view).toMatchObject({ shown: null, answered: true })
  })
  it('leads with the reply’s own steps while an asked-for AI set is written', () => {
    const view = resolveNextStepsTrayView(
      current({ ai: set({ status: 'generating' }), parsed }),
      reply
    )
    expect(view).toMatchObject({
      shown: { set: { id: 'parsed' } },
      extra: null,
      thinking: true,
      failure: null
    })
  })
  it('keeps the reply’s own steps first and offers a ready AI set beside them, never instead', () => {
    const view = resolveNextStepsTrayView(current({ ai: set({}), parsed }), reply)
    expect(view).toMatchObject({
      shown: { set: { id: 'parsed' } },
      extra: { set: { id: 'set', origin: 'ai' } },
      thinking: false
    })
  })
  it('shows the AI set in the lead only when the reply proposed nothing', () => {
    const view = resolveNextStepsTrayView(current({ ai: set({}) }), reply)
    expect(view).toMatchObject({ shown: { set: { origin: 'ai' } }, extra: null })
  })
  it('drops dismissed extra AI steps and keeps the reply’s own', () => {
    const view = resolveNextStepsTrayView(
      current({ ai: set({ status: 'superseded' }), parsed }),
      reply
    )
    expect(view).toMatchObject({ shown: { set: { id: 'parsed' } }, extra: null, answered: false })
  })
  it('shows nothing when a client-offered parsed set is for another reply', () => {
    const view = resolveNextStepsTrayView(
      current({ parsed: { ...parsed, messageId: 'older' } }),
      reply
    )
    expect(view.shown).toBeNull()
  })
})

describe('staleness guard', () => {
  const later = { ...reply, timestamp: 60_000 }
  it('shows nothing, not even a ready AI set, while the reply on screen is newer than the host’s turn', () => {
    expect(
      resolveNextStepsTrayView(current({ ai: set({}), turnCompletedAt: 10_000 }), later).shown
    ).toBeNull()
  })
  it('hides a host-parsed set without a message id the same way', () => {
    const hostParsed = set({ id: 'parsed', origin: 'parsed' })
    expect(
      resolveNextStepsTrayView(current({ parsed: hostParsed, turnCompletedAt: 10_000 }), later)
        .shown
    ).toBeNull()
    expect(
      resolveNextStepsTrayView(current({ parsed: hostParsed, turnCompletedAt: 59_000 }), later)
        .shown
    ).toMatchObject({ set: { id: 'parsed' } })
  })
  it('shows the host’s sets when its turn is at least as new as the reply', () => {
    expect(
      resolveNextStepsTrayView(current({ ai: set({}), turnCompletedAt: 60_500 }), later).shown
    ).toMatchObject({ set: { origin: 'ai' } })
  })
})

describe('pendingNextStepCounts', () => {
  it('counts the newest pending set per conversation, the reply’s own steps before the AI’s', () => {
    const counts = pendingNextStepCounts([
      set({
        id: 'p',
        origin: 'parsed',
        createdAt: 50,
        suggestions: [...set({}).suggestions, ...set({}).suggestions]
      }),
      set({ id: 'a' }),
      set({ id: 'x', status: 'accepted', conversation: { ...conversation, paneKey: 'other' } })
    ])
    expect([...counts.values()]).toEqual([2])
  })
})

describe('nextStepPromptVisibility', () => {
  const step = {
    title: 'Check the build',
    prompt: 'Check the build output.',
    risk: 'safe' as const
  }
  it('always shows an AI prompt, and keeps a parsed one behind a disclosure', () => {
    expect(nextStepPromptVisibility(step, 'ai')).toBe('always')
    expect(nextStepPromptVisibility({ ...step, prompt: 'x'.repeat(400) }, 'ai')).toBe('always')
    expect(nextStepPromptVisibility({ ...step, prompt: '  Check   the build ' }, 'ai')).toBe('none')
    expect(nextStepPromptVisibility(step, 'parsed')).toBe('closed')
    expect(nextStepPromptVisibility({ ...step, risk: 'risky' }, 'parsed')).toBe('open')
  })
})
