import { describe, expect, it } from 'vitest'
import {
  HUMAN_ATTENTION_HISTORY_MAX,
  humanAttentionId,
  humanAttentionRequestSchema,
  isValidHumanAttention,
  markHumanAttentionAnnounced,
  openHumanAttention,
  openHumanAttentionRequests,
  reconcileHumanAttention,
  resolveHumanAttention,
  unannouncedHumanAttention,
  type HumanAttentionDraft,
  type HumanAttentionRequest
} from './session-human-attention'

type Host = {
  attention?: HumanAttentionRequest[]
  outcomes: { id: string; revision: number; status: string }[]
  attempts: { id: string; state: string; planVersion?: number }[]
}

const host = (extra: Partial<Host> = {}): Host => ({
  outcomes: [{ id: 'one', revision: 1, status: 'blocked' }],
  attempts: [{ id: 'att_1', state: 'running' }],
  ...extra
})

const draft = (extra: Partial<HumanAttentionDraft> = {}): HumanAttentionDraft => ({
  kind: 'clarification',
  scope: { outcomeId: 'one', outcomeRevision: 1, attemptId: 'att_1' },
  ask: "Answer Claude's question: which offer leads?",
  why: 'Claude cannot choose this for you and is waiting for your answer.',
  recipient: { type: 'owner' },
  action: { kind: 'open-conversation', label: 'Answer', paneKey: 'tab-1:leaf-1' },
  source: { type: 'agent-prompt', ref: 'which offer leads?' },
  ...extra
})

const review = (extra: Partial<HumanAttentionDraft> = {}): HumanAttentionDraft =>
  draft({
    kind: 'review',
    scope: { outcomeId: 'one', outcomeRevision: 1, conditionId: 'my_review' },
    source: { type: 'review-condition', ref: 'my_review' },
    action: { kind: 'review-outcome', label: 'Review', conditionId: 'my_review' },
    ...extra
  })

const only = (set: Host): HumanAttentionRequest => {
  expect(set.attention).toHaveLength(1)
  return set.attention![0]!
}

describe('opening a request', () => {
  it('records an open, schema-valid request under an id that is stable for the requirement', () => {
    const opened = openHumanAttention(host(), draft(), 100)
    expect(opened.opened).toBe(true)
    expect(opened.id).toBe(humanAttentionId(draft()))
    expect(opened.id).toMatch(/^att_agent-prompt_att_1_[a-z0-9]+$/)
    const request = only(opened.set)
    expect(humanAttentionRequestSchema.parse(request)).toEqual(request)
    expect(request).toMatchObject({ id: opened.id, state: 'open', openedAt: 100 })
    expect(request.notifiedAt).toBeUndefined()
    // A different question on the same attempt is a different requirement.
    expect(humanAttentionId(draft({ source: { type: 'agent-prompt', ref: 'other?' } }))).not.toBe(
      opened.id
    )
  })

  it('is idempotent: re-observing the requirement keeps openedAt and notifiedAt', () => {
    const first = openHumanAttention(host(), draft(), 100)
    const announced = markHumanAttentionAnnounced(first.set, [first.id], 150)
    const again = openHumanAttention(announced, draft(), 9_000)
    expect(again).toEqual({ set: announced, id: first.id, opened: false })
    expect(again.set).toBe(announced)
    expect(only(again.set)).toMatchObject({ openedAt: 100, notifiedAt: 150 })
  })

  it('follows the same requirement to a newer plan version without asking or announcing again', () => {
    const first = openHumanAttention(host(), review(), 100)
    const announced = markHumanAttentionAnnounced(first.set, [first.id], 150)
    // Under plan version 2 the old scope is stale; re-observing it moves the request instead.
    expect(openHumanAttentionRequests(announced, 2)).toEqual([])
    const moved = openHumanAttention(
      announced,
      review({
        scope: { outcomeId: 'one', outcomeRevision: 1, planVersion: 2, conditionId: 'my_review' }
      }),
      9_000
    )
    expect(moved.opened).toBe(false)
    expect(moved.id).toBe(first.id)
    expect(only(moved.set)).toMatchObject({
      state: 'open',
      openedAt: 100,
      notifiedAt: 150,
      scope: { planVersion: 2 }
    })
    expect(openHumanAttentionRequests(moved.set, 2)).toHaveLength(1)
    expect(unannouncedHumanAttention(moved.set, 2)).toEqual([])
  })

  it('refuses a request that does not say what the person must provide', () => {
    expect(() => openHumanAttention(host(), draft({ ask: '   ' }), 100)).toThrow()
    expect(() => openHumanAttention(host(), draft({ why: '' }), 100)).toThrow()
  })
})

describe('resolving a request', () => {
  it('is not resolved by looking at it, or by a pass that still asks for it', () => {
    const opened = openHumanAttention(host(), draft(), 100)
    expect(openHumanAttentionRequests(opened.set)).toHaveLength(1)
    expect(unannouncedHumanAttention(opened.set)).toHaveLength(1)
    expect(resolveHumanAttention(opened.set, 'att_unknown', 'Seen.', 200)).toBe(opened.set)
    expect(reconcileHumanAttention(opened.set, new Set([opened.id]), 200)).toBe(opened.set)
    expect(only(opened.set).state).toBe('open')
  })

  it('resolves once, with when and how, and then interrupts nobody', () => {
    const opened = openHumanAttention(host(), draft(), 100)
    const resolved = resolveHumanAttention(opened.set, opened.id, 'Answered.', 200)
    expect(only(resolved)).toMatchObject({
      state: 'resolved',
      openedAt: 100,
      resolvedAt: 200,
      resolution: 'Answered.'
    })
    expect(openHumanAttentionRequests(resolved)).toEqual([])
    expect(resolveHumanAttention(resolved, opened.id, 'Again.', 300)).toBe(resolved)
  })

  it('never writes a resolution the schema cannot read back', () => {
    const opened = openHumanAttention(host(), draft(), 100)
    const blank = only(resolveHumanAttention(opened.set, opened.id, '   ', 200))
    expect(blank.resolution).toBe('Resolved.')
    expect(humanAttentionRequestSchema.safeParse(blank).success).toBe(true)
    const long = only(resolveHumanAttention(opened.set, opened.id, 'x'.repeat(500), 200))
    expect(long.resolution).toHaveLength(200)
    expect(humanAttentionRequestSchema.safeParse(long).success).toBe(true)
  })
})

describe('the reconciler pass', () => {
  it('resolves the requirements that are no longer asked for and keeps the ones that are', () => {
    const question = openHumanAttention(host(), draft(), 100)
    const both = openHumanAttention(question.set, review(), 110)
    const next = reconcileHumanAttention(both.set, new Set([both.id]), 200)
    expect(next.attention?.map((entry) => [entry.id, entry.state])).toEqual([
      [question.id, 'resolved'],
      [both.id, 'open']
    ])
    expect(next.attention?.[0]).toMatchObject({
      resolvedAt: 200,
      resolution: 'The requirement was met.'
    })
  })

  it.each([
    [
      'the outcome was revised',
      host({ outcomes: [{ id: 'one', revision: 2, status: 'blocked' }] })
    ],
    [
      'the outcome was removed',
      host({ outcomes: [{ id: 'two', revision: 1, status: 'pending' }] })
    ],
    [
      'the outcome is satisfied',
      host({ outcomes: [{ id: 'one', revision: 1, status: 'satisfied' }] })
    ],
    ['the attempt completed', host({ attempts: [{ id: 'att_1', state: 'completed' }] })],
    ['the attempt was superseded', host({ attempts: [{ id: 'att_1', state: 'superseded' }] })],
    [
      'the attempt was given up for a retry',
      host({ attempts: [{ id: 'att_1', state: 'retryable' }] })
    ],
    ['the attempt is gone', host({ attempts: [] })]
  ])('withdraws a request whose scope is stale: %s', (_why, moved) => {
    const opened = openHumanAttention(host(), draft(), 100)
    const stale: Host = { ...moved, attention: opened.set.attention }
    expect(isValidHumanAttention(stale, only(stale))).toBe(false)
    expect(openHumanAttentionRequests(stale)).toEqual([])
    // Still listed by the pass: a stale scope is withdrawn whatever the pass asks for.
    const next = reconcileHumanAttention(stale, new Set([opened.id]), 200)
    expect(only(next)).toMatchObject({
      state: 'withdrawn',
      resolvedAt: 200,
      resolution: 'The run moved on.'
    })
  })

  it('withdraws a request of an older plan version, and keeps one of the current version', () => {
    const old = openHumanAttention(host(), draft(), 100)
    expect(only(reconcileHumanAttention(old.set, new Set([old.id]), 200, 2)).state).toBe(
      'withdrawn'
    )
    const current = openHumanAttention(
      host(),
      draft({
        scope: { outcomeId: 'one', outcomeRevision: 1, planVersion: 2, attemptId: 'att_1' }
      }),
      100
    )
    expect(reconcileHumanAttention(current.set, new Set([current.id]), 200, 2)).toBe(current.set)
    // A blocked attempt is still the current unsettled one: its requirement stands.
    const blocked: Host = { ...old.set, attempts: [{ id: 'att_1', state: 'blocked' }] }
    expect(reconcileHumanAttention(blocked, new Set([old.id]), 200)).toBe(blocked)
  })

  it('re-opens a resolved requirement only when it is asked again', () => {
    const opened = openHumanAttention(host(), draft(), 100)
    const announced = markHumanAttentionAnnounced(opened.set, [opened.id], 150)
    const resolved = resolveHumanAttention(announced, opened.id, 'Answered.', 200)
    // Passes that do not ask for it change nothing, whether or not they list it.
    expect(reconcileHumanAttention(resolved, new Set(), 300)).toBe(resolved)
    expect(reconcileHumanAttention(resolved, new Set([opened.id]), 300)).toBe(resolved)
    expect(openHumanAttentionRequests(resolved)).toEqual([])
    const again = openHumanAttention(resolved, draft(), 400)
    expect(again).toMatchObject({ id: opened.id, opened: true })
    const request = only(again.set)
    expect(request).toMatchObject({ state: 'open', openedAt: 400 })
    expect(request.resolvedAt).toBeUndefined()
    expect(request.resolution).toBeUndefined()
    // Asked again is a new ask: it is announced again, once.
    expect(request.notifiedAt).toBeUndefined()
  })
})

describe('announcing', () => {
  it('lists only open owner requests not yet announced, and stamps each exactly once', () => {
    const mine = openHumanAttention(host(), draft(), 100)
    const theirs = openHumanAttention(
      mine.set,
      review({ recipient: { type: 'person', employeeId: 'emp_gamma', name: 'Gamma' } }),
      110
    )
    expect(unannouncedHumanAttention(theirs.set).map((entry) => entry.id)).toEqual([mine.id])
    const stamped = markHumanAttentionAnnounced(theirs.set, [mine.id], 150)
    expect(stamped.attention?.map((entry) => entry.notifiedAt)).toEqual([150, undefined])
    expect(unannouncedHumanAttention(stamped)).toEqual([])
    // A reconnect that announces again is a no-op: same object, same stamp.
    expect(markHumanAttentionAnnounced(stamped, [mine.id], 900)).toBe(stamped)
    expect(stamped.attention?.[0]?.notifiedAt).toBe(150)
    expect(markHumanAttentionAnnounced(stamped, [], 900)).toBe(stamped)
    expect(markHumanAttentionAnnounced(stamped, ['att_unknown'], 900)).toBe(stamped)
    expect(markHumanAttentionAnnounced(host(), [mine.id], 900).attention).toBeUndefined()
  })

  it('does not announce a request that no longer describes the run', () => {
    const opened = openHumanAttention(host(), draft(), 100)
    const stale: Host = { ...opened.set, attempts: [{ id: 'att_1', state: 'superseded' }] }
    expect(unannouncedHumanAttention(stale)).toEqual([])
  })
})

describe('the settled history', () => {
  const question = (index: number): HumanAttentionDraft =>
    draft({ source: { type: 'agent-prompt', ref: `question ${index}` } })

  it('never drops an open request, however many there are', () => {
    let set = host()
    for (let index = 0; index < HUMAN_ATTENTION_HISTORY_MAX + 6; index++) {
      set = openHumanAttention(set, question(index), 100 + index).set
    }
    expect(set.attention).toHaveLength(HUMAN_ATTENTION_HISTORY_MAX + 6)
    expect(openHumanAttentionRequests(set)).toHaveLength(HUMAN_ATTENTION_HISTORY_MAX + 6)
  })

  it('keeps at most the cap, dropping the oldest settled requests first', () => {
    let set = host()
    const ids: string[] = []
    for (let index = 0; index < HUMAN_ATTENTION_HISTORY_MAX + 6; index++) {
      const opened = openHumanAttention(set, question(index), 100 + index)
      ids.push(opened.id)
      set = resolveHumanAttention(opened.set, opened.id, 'Answered.', 100 + index)
    }
    expect(new Set(ids).size).toBe(ids.length)
    expect(set.attention).toHaveLength(HUMAN_ATTENTION_HISTORY_MAX)
    expect(set.attention?.map((entry) => entry.id)).toEqual(ids.slice(6))
  })
})
