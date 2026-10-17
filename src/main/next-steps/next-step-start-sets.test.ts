import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type {
  NextStepDecision,
  NextStepSuggestion,
  NextStepSuggestionSet
} from '../../shared/next-step-suggestions'
import type { NextStepStartRequest } from './next-step-start-generator'
import {
  carryOverSource,
  collectCarryOver,
  NEXT_STEP_CARRIED_REASON
} from './next-step-start-carry-over'
import {
  decideNextStepStart,
  NEXT_STEP_OTHER_CONVERSATION,
  NEXT_STEP_START_NEEDS_CONVERSATION,
  NEXT_STEP_START_NOT_FRESH,
  NEXT_STEP_START_REPLACED,
  routeNextStepDecision
} from './next-step-start-decide'
import {
  mergeStartSuggestions,
  nextStepStartTurnKey,
  NEXT_STEP_START_OFF_REASON,
  suggestNextStepStart
} from './next-step-start-sets'
import {
  NextStepSuggestionService,
  type NextStepGenerateOutcome
} from './next-step-suggestion-service'
import { NextStepSuggestionStore } from './next-step-suggestion-store'
import { noteNextStepStartActivity } from './next-step-start-activity'
import type { PromptQueue } from '../../shared/prompt-queue-types'
import type { FinishedTurn } from './next-step-turn-signal'
import { NEXT_STEP_EARLIER_TURN_REASON } from './next-step-turn-answers'

let dir: string
const stores: NextStepSuggestionStore[] = []
const WT = 'repo::/w'
// 2026-09-23 14:20 UTC
const NOW = Date.UTC(2026, 8, 23, 14, 20)

const source = (paneKey = 'tab-1:leaf-1'): ConversationSource => ({
  worktreeId: WT,
  paneKey,
  kind: 'pty'
})

const step = (id: string, title: string, risk: 'safe' | 'risky' = 'safe'): NextStepSuggestion => ({
  id,
  title,
  prompt: `Please ${title.toLowerCase()}.`,
  risk,
  kind: 'continue'
})

const offered = (over: Partial<NextStepSuggestionSet> = {}): NextStepSuggestionSet => ({
  id: 'old-ai',
  conversation: source('tab-0:leaf-0'),
  worktreeId: WT,
  turnKey: 'tab-0:leaf-0@1',
  origin: 'ai',
  createdAt: NOW - 60_000,
  status: 'pending',
  suggestions: [step('a1', 'Finish the parser'), step('a2', 'Update the changelog')],
  ...over
})

type Call = { request: NextStepStartRequest; resolve: (outcome: NextStepGenerateOutcome) => void }

function harness(
  options: {
    enabled?: boolean
    sets?: NextStepSuggestionSet[]
    live?: ((conversation: ConversationSource) => boolean) | 'unknown'
    latestTurn?: FinishedTurn | null
    readLatestTurn?: (conversation: ConversationSource) => Promise<FinishedTurn | null>
    queue?: PromptQueue | null
  } = {}
) {
  const store = new NextStepSuggestionStore({ directory: dir, now: () => NOW })
  stores.push(store)
  for (const set of options.sets ?? []) {
    store.upsert(set)
  }
  const calls: Call[] = []
  const enqueue = vi.fn()
  const service = new NextStepSuggestionService({
    store,
    settings: () => ({ enabled: options.enabled ?? true }),
    readPromptQueue: () => options.queue ?? null,
    isChainBound: () => false,
    enqueue,
    generate: vi.fn(),
    ...(options.live === 'unknown' ? {} : { isConversationLive: options.live ?? (() => false) }),
    // Only the conversation the turn belongs to has it.
    readLatestTurn:
      options.readLatestTurn ??
      (async (conversation) =>
        options.latestTurn &&
        conversationSourceRowKey(options.latestTurn.conversation) ===
          conversationSourceRowKey(conversation)
          ? options.latestTurn
          : null),
    generateStart: (request) =>
      new Promise<NextStepGenerateOutcome>((resolve) => calls.push({ request, resolve }))
  })
  return { store, service, calls, enqueue }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'next-step-start-'))
})
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.flush()))
  rmSync(dir, { recursive: true, force: true })
})

describe('nextStepStartTurnKey', () => {
  it('is the workspace and the UTC hour, so one set serves a workspace for about an hour', () => {
    expect(nextStepStartTurnKey(WT, NOW)).toBe('start:repo::/w:2026-09-23-14')
    expect(nextStepStartTurnKey(WT, NOW + 30 * 60_000)).toBe('start:repo::/w:2026-09-23-14')
    expect(nextStepStartTurnKey(WT, NOW + 45 * 60_000)).toBe('start:repo::/w:2026-09-23-15')
  })
})

describe('carry-over', () => {
  const finished = () => false
  it('takes the last finished conversation’s unanswered set, parsed before AI, never another workspace', () => {
    const parsed = offered({
      id: 'parsed',
      origin: 'parsed',
      createdAt: NOW - 1,
      suggestions: [step('p1', 'Merge the two PRs')]
    })
    expect(carryOverSource([offered(), parsed], WT, finished)?.id).toBe('parsed')
    const sets = [
      offered(),
      offered({ id: 'answered', status: 'accepted', createdAt: NOW + 1 }),
      offered({ id: 'dismissed', status: 'dismissed', createdAt: NOW + 2 }),
      offered({ id: 'elsewhere', worktreeId: 'repo::/other', createdAt: NOW + 3 })
    ]
    expect(carryOverSource(sets, WT, finished)?.id).toBe('old-ai')
    expect(
      collectCarryOver(carryOverSource(sets, WT, finished), undefined).map((s) => [s.id, s.title])
    ).toEqual([
      ['c1', 'Finish the parser'],
      ['c2', 'Update the changelog']
    ])
    expect(carryOverSource([offered({ status: 'dismissed' })], WT, finished)).toBeNull()
  })

  it('never takes a set from a live conversation, nor when liveness is unknown', () => {
    expect(carryOverSource([offered()], WT, () => true)).toBeNull()
    expect(carryOverSource([offered()], WT, undefined)).toBeNull()
  })

  it('makes a carried title one bounded line', () => {
    const [carried] = collectCarryOver(
      offered({ suggestions: [step('a1', `Line one\nline two ${'x'.repeat(300)}`)] }),
      undefined
    )
    expect(carried!.title).not.toContain('\n')
    expect(carried!.title.length).toBeLessThanOrEqual(120)
  })
})

describe('suggestNextStepStart', () => {
  it('returns carry-over only, with no model call, when the setting is off', () => {
    const { service, calls } = harness({ enabled: false, sets: [offered()] })
    const result = suggestNextStepStart(service, { worktreeId: WT }, NOW)
    expect(calls).toHaveLength(0)
    expect(result.set).toMatchObject({
      origin: 'start',
      status: 'pending',
      turnKey: 'start:repo::/w:2026-09-23-14'
    })
    expect(result.set?.conversation).toBeUndefined()
    expect(result.set?.suggestions.map((s) => s.id)).toEqual(['c1', 'c2'])
  })

  it('settles the carried set so its steps can never run twice, and keeps them on a retry', () => {
    const { service, store } = harness({
      sets: [offered(), offered({ id: 'old-parsed', origin: 'parsed', createdAt: NOW - 90_000 })]
    })
    const first = suggestNextStepStart(service, { worktreeId: WT }, NOW)
    for (const id of ['old-ai', 'old-parsed']) {
      expect(store.get(id)).toMatchObject({
        status: 'superseded',
        error: NEXT_STEP_CARRIED_REASON
      })
    }
    const again = suggestNextStepStart(service, { worktreeId: WT, force: true }, NOW)
    expect(again.set?.id).not.toBe(first.set!.id)
    expect(again.set?.suggestions.map((s) => s.id)).toEqual(['c1', 'c2'])
  })

  it('offers nothing, and says why, when off and nothing is left over', () => {
    const { service } = harness({ enabled: false })
    expect(suggestNextStepStart(service, { worktreeId: WT }, NOW)).toEqual({
      set: null,
      skipped: NEXT_STEP_START_OFF_REASON
    })
  })

  it('shows carry-over at once and merges the AI’s first steps in front of it', async () => {
    const { service, store, calls } = harness({ sets: [offered()] })
    const first = suggestNextStepStart(
      service,
      { worktreeId: WT, taskId: 'btk_1', agent: 'claude' },
      NOW
    )
    expect(first.set).toMatchObject({ status: 'generating' })
    expect(first.set?.suggestions.map((s) => s.id)).toEqual(['c1', 'c2'])
    expect(calls[0]!.request).toMatchObject({ worktreeId: WT, taskId: 'btk_1', agent: 'claude' })
    expect(calls[0]!.request.carryOver.map((s) => s.id)).toEqual(['c1', 'c2'])
    calls[0]!.resolve({
      ok: true,
      suggestions: [step('s1', 'Run the tests'), step('s2', 'Finish the parser')],
      model: 'sonnet'
    })
    await settle()
    const settled = store.get(first.set!.id)!
    expect(settled).toMatchObject({ status: 'pending', model: 'sonnet' })
    expect(settled.suggestions.map((s) => s.id)).toEqual(['s1', 's2', 'c2'])
  })

  it('keeps carry-over usable when the call fails, and fails only an empty set', async () => {
    const withCarry = harness({ sets: [offered()] })
    const kept = suggestNextStepStart(withCarry.service, { worktreeId: WT }, NOW)
    withCarry.calls[0]!.resolve({ ok: false, error: 'Codex is not signed in.' })
    await settle()
    expect(withCarry.store.get(kept.set!.id)).toMatchObject({
      status: 'pending',
      error: 'Codex is not signed in.'
    })
    const empty = harness()
    const failed = suggestNextStepStart(empty.service, { worktreeId: WT }, NOW)
    empty.calls[0]!.resolve({ ok: false, error: 'No model.' })
    await settle()
    expect(empty.store.get(failed.set!.id)).toMatchObject({ status: 'failed' })
  })

  it('is cached for the hour, regenerated on force, and new in the next hour', async () => {
    const { service, calls, store } = harness()
    const first = suggestNextStepStart(service, { worktreeId: WT }, NOW)
    expect(suggestNextStepStart(service, { worktreeId: WT }, NOW + 60_000).set?.id).toBe(
      first.set!.id
    )
    expect(calls).toHaveLength(1)
    const forced = suggestNextStepStart(service, { worktreeId: WT, force: true }, NOW + 60_000)
    expect(forced.set?.id).not.toBe(first.set!.id)
    expect(store.get(first.set!.id)?.status).toBe('superseded')
    expect(calls[0]!.request).toBeDefined()
    const nextHour = suggestNextStepStart(service, { worktreeId: WT }, NOW + 60 * 60_000)
    expect(nextHour.set?.turnKey).toBe('start:repo::/w:2026-09-23-15')
  })

  it('carries nothing when liveness is unknown, and leaves the source set alone', () => {
    const { service, store } = harness({ enabled: false, sets: [offered()], live: 'unknown' })
    expect(suggestNextStepStart(service, { worktreeId: WT }, NOW).set).toBeNull()
    expect(store.get('old-ai')?.status).toBe('pending')
  })

  it('gives two tabs asking in the same hour one shared set', () => {
    const { service, calls } = harness()
    const tabA = suggestNextStepStart(service, { worktreeId: WT }, NOW)
    const tabB = suggestNextStepStart(service, { worktreeId: WT }, NOW + 5_000)
    expect(tabB.set?.id).toBe(tabA.set?.id)
    expect(calls).toHaveLength(1)
  })

  it('skips carry-over from a live conversation and leaves its set alone', () => {
    const { service, store } = harness({ enabled: false, sets: [offered()], live: () => true })
    expect(suggestNextStepStart(service, { worktreeId: WT }, NOW).set).toBeNull()
    expect(store.get('old-ai')?.status).toBe('pending')
  })

  it('carries the previous hour’s unanswered steps into the new hour before retiring it', () => {
    const { service, store } = harness({ enabled: false, sets: [offered()] })
    const earlier = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    const later = suggestNextStepStart(service, { worktreeId: WT }, NOW + 60 * 60_000).set!
    expect(later.id).not.toBe(earlier.id)
    expect(later.suggestions.map((s) => s.title)).toEqual([
      'Finish the parser',
      'Update the changelog'
    ])
    expect(store.get(earlier.id)?.status).toBe('superseded')
  })

  it('stays hidden for the hour once dismissed', async () => {
    const { service, calls } = harness({ enabled: false, sets: [offered()] })
    const set = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    await decideNextStepStart(service, set.id, { action: 'dismiss' }, source())
    expect(suggestNextStepStart(service, { worktreeId: WT }, NOW + 60_000).set).toMatchObject({
      id: set.id,
      status: 'dismissed'
    })
    expect(calls).toHaveLength(0)
  })
})

describe('decideNextStepStart', () => {
  it('binds the set to the new conversation and queues the chosen prompts in the set’s order', async () => {
    const { service, store, enqueue } = harness({ enabled: false, sets: [offered()] })
    const set = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    const result = await decideNextStepStart(
      service,
      set.id,
      { action: 'run', suggestionIds: ['c2', 'c1'] },
      source()
    )
    expect(result.queued).toEqual(['c1', 'c2'])
    // The first queued prompt is the empty conversation's first message; the next waits its turn.
    expect(enqueue.mock.calls.map(([to, entry]) => [to, entry.text])).toEqual([
      [source(), 'Please finish the parser.'],
      [source(), 'Please update the changelog.']
    ])
    expect(store.get(set.id)).toMatchObject({ status: 'accepted', conversation: source() })
  })

  it('undoes the binding when nothing could be queued, and refuses another conversation', async () => {
    const { service, store, enqueue } = harness({ enabled: false, sets: [offered()] })
    const set = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    enqueue.mockImplementation(() => {
      throw new Error('The queue is full.')
    })
    const refused = await decideNextStepStart(
      service,
      set.id,
      { action: 'run', suggestionIds: ['c1'] },
      source()
    )
    expect(refused.notQueued).toEqual([{ id: 'c1', reason: 'The queue is full.' }])
    expect(store.get(set.id)).toMatchObject({ status: 'pending' })
    expect(store.get(set.id)?.conversation).toBeUndefined()
    enqueue.mockReset()
    await decideNextStepStart(service, set.id, { action: 'run', suggestionIds: ['c1'] }, source())
    await expect(
      decideNextStepStart(
        service,
        set.id,
        { action: 'run', suggestionIds: ['c2'] },
        source('tab-9:leaf-9')
      )
    ).rejects.toThrow(/another conversation|can no longer be answered/)
    await expect(
      decideNextStepStart(service, 'old-ai', { action: 'dismiss' }, source())
    ).rejects.toThrow(/Only suggested starts/)
  })

  it('refuses ids that are not in the set before claiming anything', async () => {
    const { service, store, enqueue } = harness({ enabled: false, sets: [offered()] })
    const set = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    await expect(
      // `a1` is a real id, but of the carried source set, not of this one.
      decideNextStepStart(service, set.id, { action: 'run', suggestionIds: ['c1', 'a1'] }, source())
    ).rejects.toThrow(/not in this set: a1/)
    expect(enqueue).not.toHaveBeenCalled()
    expect(store.get(set.id)).toMatchObject({ status: 'pending' })
  })

  it('runs only in a fresh conversation: no observed turn, no sets of its own', async () => {
    const turn: FinishedTurn = {
      conversation: source(),
      turnKey: 'tab-1:leaf-1@9',
      lastAssistantMessage: 'Done.'
    }
    const restarted = harness({ enabled: false, sets: [offered()], latestTurn: turn })
    const set = suggestNextStepStart(restarted.service, { worktreeId: WT }, NOW).set!
    await expect(
      decideNextStepStart(
        restarted.service,
        set.id,
        { action: 'run', suggestionIds: ['c1'] },
        source()
      )
    ).rejects.toThrow(NEXT_STEP_START_NOT_FRESH)
    // The claim was released: the set can still start another conversation.
    expect(restarted.store.get(set.id)).toMatchObject({ status: 'pending' })
    expect(restarted.store.get(set.id)?.conversation).toBeUndefined()
    await expect(
      decideNextStepStart(
        restarted.service,
        set.id,
        { action: 'run', suggestionIds: ['c1'] },
        source('tab-0:leaf-0')
      )
    ).rejects.toThrow(NEXT_STEP_START_NOT_FRESH)
    expect(restarted.enqueue).not.toHaveBeenCalled()
  })

  it('lets exactly one of two tabs take a set; the other is refused plainly', async () => {
    const { service, enqueue } = harness({ enabled: false, sets: [offered()] })
    const set = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    const results = await Promise.allSettled([
      decideNextStepStart(service, set.id, { action: 'run', suggestionIds: ['c1'] }, source()),
      decideNextStepStart(
        service,
        set.id,
        { action: 'run', suggestionIds: ['c1'] },
        source('tab-2:leaf-2')
      )
    ])
    expect(results[0]).toMatchObject({ status: 'fulfilled' })
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringMatching(/already taken/) })
    })
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('stays bound after a partial queue and names what was not queued', async () => {
    const { service, store, enqueue } = harness({ enabled: false, sets: [offered()] })
    const set = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    enqueue
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('The queue is full.')
      })
    const result = await decideNextStepStart(
      service,
      set.id,
      { action: 'run', suggestionIds: ['c1', 'c2'] },
      source()
    )
    expect(result.queued).toEqual(['c1'])
    expect(result.notQueued).toEqual([{ id: 'c2', reason: 'The queue is full.' }])
    expect(store.get(set.id)).toMatchObject({ status: 'accepted', conversation: source() })
  })
})

describe('routeNextStepDecision', () => {
  it('routes by the stored set: a start set needs a conversation, another set only its own', async () => {
    const { service, store } = harness({ enabled: false, sets: [offered()], live: () => true })
    store.upsert({
      id: 'start-x',
      worktreeId: WT,
      turnKey: 'start:x',
      origin: 'start',
      createdAt: NOW,
      status: 'pending',
      suggestions: [step('c1', 'Finish the parser')]
    })
    await expect(
      routeNextStepDecision(service, 'start-x', { action: 'dismiss' }, undefined)
    ).rejects.toThrow(NEXT_STEP_START_NEEDS_CONVERSATION)
    await expect(
      routeNextStepDecision(service, 'old-ai', { action: 'dismiss' }, source('tab-5:leaf-5'))
    ).rejects.toThrow(NEXT_STEP_OTHER_CONVERSATION)
    expect(store.get('old-ai')?.status).toBe('pending')
    // The turn path now needs the host to know the set's turn is current.
    service.currentTurns.set(conversationSourceRowKey(source('tab-0:leaf-0')), {
      turnKey: 'tab-0:leaf-0@1'
    })
    await expect(
      routeNextStepDecision(service, 'old-ai', { action: 'dismiss' }, source('tab-0:leaf-0'))
    ).resolves.toMatchObject({ set: { status: 'dismissed' } })
  })

  it('sends a start set down the start path, never through the current-turn check', async () => {
    const { service, enqueue } = harness({ enabled: false, sets: [offered()] })
    const set = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    // The fresh conversation has no current turn, which the turn path would refuse as earlier.
    await expect(
      routeNextStepDecision(service, set.id, { action: 'run', suggestionIds: ['c1'] }, source())
    ).resolves.toMatchObject({ queued: ['c1'] })
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('checks workspace and freshness for every action, and refuses an unknown one', async () => {
    const turn: FinishedTurn = {
      conversation: source(),
      turnKey: 'tab-1:leaf-1@9',
      lastAssistantMessage: 'Done.'
    }
    const { service, store } = harness({ enabled: false, sets: [offered()], latestTurn: turn })
    const set = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    const decisions: NextStepDecision[] = [
      { action: 'run', suggestionIds: ['c1'] },
      { action: 'save', suggestionIds: ['c1'] },
      { action: 'dismiss' }
    ]
    for (const decision of decisions) {
      await expect(
        decideNextStepStart(service, set.id, decision, { ...source(), worktreeId: 'repo::/other' })
      ).rejects.toThrow(/another workspace/)
      await expect(decideNextStepStart(service, set.id, decision, source())).rejects.toThrow(
        NEXT_STEP_START_NOT_FRESH
      )
      expect(store.get(set.id)).toMatchObject({ status: 'pending' })
      expect(store.get(set.id)?.conversation).toBeUndefined()
    }
    await expect(
      decideNextStepStart(service, set.id, { action: 'merge' } as never, source('tab-3:leaf-3'))
    ).rejects.toThrow(/not one a suggested start accepts/)
    await expect(
      decideNextStepStart(service, set.id, { action: 'dismiss' }, source('tab-3:leaf-3'))
    ).resolves.toMatchObject({ set: { status: 'dismissed', conversation: source('tab-3:leaf-3') } })
  })

  it('releases the claim when the freshness check throws or hangs', async () => {
    const throwing = harness({
      enabled: false,
      sets: [offered()],
      readLatestTurn: async () => {
        throw new Error('hook server down')
      }
    })
    const set = suggestNextStepStart(throwing.service, { worktreeId: WT }, NOW).set!
    await expect(
      decideNextStepStart(
        throwing.service,
        set.id,
        { action: 'run', suggestionIds: ['c1'] },
        source()
      )
    ).rejects.toThrow(/hook server down/)
    expect(throwing.store.get(set.id)).toMatchObject({ status: 'pending' })
    expect(throwing.store.get(set.id)?.conversation).toBeUndefined()
    expect(throwing.enqueue).not.toHaveBeenCalled()

    const hanging = harness({
      enabled: false,
      sets: [offered()],
      readLatestTurn: () => new Promise<never>(() => {})
    })
    const held = suggestNextStepStart(hanging.service, { worktreeId: WT }, NOW).set!
    await expect(
      decideNextStepStart(
        hanging.service,
        held.id,
        { action: 'save', suggestionIds: ['c1'] },
        source(),
        { freshnessTimeoutMs: 5 }
      )
    ).rejects.toThrow(/could not confirm/)
    expect(hanging.store.get(held.id)).toMatchObject({ status: 'pending' })
    expect(hanging.store.get(held.id)?.conversation).toBeUndefined()
    expect(hanging.enqueue).not.toHaveBeenCalled()
  })

  it('reads the latest turn for the conversation it was asked about only', async () => {
    const turn: FinishedTurn = {
      conversation: source('tab-7:leaf-7'),
      turnKey: 'tab-7:leaf-7@1',
      lastAssistantMessage: 'Done.'
    }
    const { service, enqueue } = harness({ enabled: false, sets: [offered()], latestTurn: turn })
    const set = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    await expect(
      decideNextStepStart(service, set.id, { action: 'run', suggestionIds: ['c1'] }, source())
    ).resolves.toMatchObject({ queued: ['c1'] })
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('routes a start set around the current-turn check that refuses a stale turn set', async () => {
    const busy = source('tab-4:leaf-4')
    const stale = offered({ id: 'stale-ai', conversation: busy, turnKey: 'tab-4:leaf-4@1' })
    const { service, store } = harness({
      enabled: false,
      sets: [offered(), stale],
      live: (conversation) =>
        conversationSourceRowKey(conversation) === conversationSourceRowKey(busy)
    })
    const start = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    service.currentTurns.set(conversationSourceRowKey(busy), { turnKey: 'tab-4:leaf-4@2' })
    await expect(
      routeNextStepDecision(service, 'stale-ai', { action: 'dismiss' }, busy)
    ).rejects.toThrow(NEXT_STEP_EARLIER_TURN_REASON)
    await expect(
      routeNextStepDecision(service, start.id, { action: 'dismiss' }, busy)
    ).rejects.toThrow(NEXT_STEP_START_NOT_FRESH)
    await expect(
      routeNextStepDecision(service, start.id, { action: 'run', suggestionIds: ['c1'] }, source())
    ).resolves.toMatchObject({ queued: ['c1'] })
    expect(store.get('stale-ai')?.status).toBe('pending')
  })

  it('re-checks after the freshness await: a turn observed meanwhile queues nothing', async () => {
    let answer: (turn: FinishedTurn | null) => void = () => undefined
    const { service, store, enqueue } = harness({
      enabled: false,
      sets: [offered()],
      readLatestTurn: () =>
        new Promise<FinishedTurn | null>((resolve) => {
          answer = resolve
        })
    })
    const set = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    const deciding = decideNextStepStart(
      service,
      set.id,
      { action: 'run', suggestionIds: ['c1'] },
      source()
    )
    // The agent reports a real turn while the host is still reading.
    service.currentTurns.set(conversationSourceRowKey(source()), { turnKey: 'tab-1:leaf-1@1' })
    answer(null)
    await expect(deciding).rejects.toThrow(NEXT_STEP_START_NOT_FRESH)
    expect(enqueue).not.toHaveBeenCalled()
    expect(store.get(set.id)).toMatchObject({ status: 'pending' })
    expect(store.get(set.id)?.conversation).toBeUndefined()
  })

  it('retires, never reopens, a claimed set replaced in the next hour; only one set queues', async () => {
    let failRead: (error: Error) => void = () => undefined
    let reads = 0
    const { service, store, enqueue, calls } = harness({
      sets: [offered()],
      readLatestTurn: () => {
        reads += 1
        return reads === 1
          ? new Promise<never>((_resolve, reject) => {
              failRead = reject
            })
          : Promise.resolve(null)
      }
    })
    const hour14 = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    calls[0]!.resolve({ ok: true, suggestions: [step('s1', 'Run the tests')] })
    await settle()
    // Tab A claims the 14:00 set and waits on the host.
    const tabA = decideNextStepStart(
      service,
      hour14.id,
      { action: 'run', suggestionIds: ['c1'] },
      source()
    )
    // At 15:00 tab B gets the replacement.
    const hour15 = suggestNextStepStart(service, { worktreeId: WT }, NOW + 60 * 60_000).set!
    calls[1]!.resolve({ ok: true, suggestions: [step('s1', 'Review the diff')] })
    await settle()
    expect(hour15.id).not.toBe(hour14.id)
    failRead(new Error('hook server down'))
    await expect(tabA).rejects.toThrow(/hook server down/)
    expect(store.get(hour14.id)).toMatchObject({
      status: 'superseded',
      error: NEXT_STEP_START_REPLACED
    })
    expect(store.get(hour14.id)?.conversation).toBeUndefined()
    await expect(
      decideNextStepStart(service, hour14.id, { action: 'run', suggestionIds: ['c1'] }, source())
    ).rejects.toThrow(/superseded/)
    await expect(
      decideNextStepStart(
        service,
        hour15.id,
        { action: 'run', suggestionIds: ['s1'] },
        source('tab-2:leaf-2')
      )
    ).resolves.toMatchObject({ queued: ['s1'] })
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('refuses and retires a claim whose set was replaced while its freshness check passed', async () => {
    let answer: (turn: FinishedTurn | null) => void = () => undefined
    const { service, store, enqueue, calls } = harness({
      sets: [offered()],
      readLatestTurn: () =>
        new Promise<FinishedTurn | null>((resolve) => {
          answer = resolve
        })
    })
    const old = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    calls[0]!.resolve({ ok: true, suggestions: [step('s1', 'Run the tests')] })
    await settle()
    const deciding = decideNextStepStart(
      service,
      old.id,
      { action: 'run', suggestionIds: ['c1'] },
      source()
    )
    suggestNextStepStart(service, { worktreeId: WT, force: true }, NOW + 1_000)
    answer(null)
    await expect(deciding).rejects.toThrow(NEXT_STEP_START_REPLACED)
    expect(enqueue).not.toHaveBeenCalled()
    expect(store.get(old.id)).toMatchObject({ status: 'superseded' })
  })

  it('never creates, and never answers, a start set that repeats an id', async () => {
    expect(
      mergeStartSuggestions(
        [step('c1', 'Run the tests'), step('s2', 'Review the diff')],
        [step('c1', 'Finish the parser'), step('c2', 'Update the changelog')]
      ).map((s) => s.id)
    ).toEqual(['c1', 's2', 'c2'])
    const { service, store, enqueue } = harness({ enabled: false })
    store.upsert({
      id: 'start-dup',
      worktreeId: WT,
      turnKey: nextStepStartTurnKey(WT, NOW),
      origin: 'start',
      createdAt: NOW,
      status: 'pending',
      suggestions: [step('c1', 'Run the tests'), step('c1', 'Deploy to prod', 'risky')]
    })
    for (const decision of [
      { action: 'run', suggestionIds: ['c1'] },
      { action: 'dismiss' }
    ] satisfies NextStepDecision[]) {
      await expect(decideNextStepStart(service, 'start-dup', decision, source())).rejects.toThrow(
        /repeat an id/
      )
    }
    expect(enqueue).not.toHaveBeenCalled()
    expect(store.get('start-dup')).toMatchObject({ status: 'pending' })
    expect(store.get('start-dup')?.conversation).toBeUndefined()
  })

  it('treats the person starting a turn during the freshness await as not fresh', async () => {
    let answer: (turn: FinishedTurn | null) => void = () => undefined
    const { service, store, enqueue } = harness({
      enabled: false,
      sets: [offered()],
      readLatestTurn: () =>
        new Promise<FinishedTurn | null>((resolve) => {
          answer = resolve
        })
    })
    const set = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    const deciding = decideNextStepStart(
      service,
      set.id,
      { action: 'run', suggestionIds: ['c1'] },
      source()
    )
    // The person sends their own first message; the host sees the pane go busy.
    noteNextStepStartActivity(service, { kind: 'busy', conversation: source() })
    answer(null)
    await expect(deciding).rejects.toThrow(NEXT_STEP_START_NOT_FRESH)
    expect(enqueue).not.toHaveBeenCalled()
    expect(store.get(set.id)).toMatchObject({ status: 'pending' })
  })

  it('refuses a conversation that already has anything in its prompt queue', async () => {
    const queue = {
      source: source(),
      entries: [{ id: 'mine', text: 'Fix the parser', createdAt: NOW, state: 'queued' }]
    } as unknown as PromptQueue
    const { service, enqueue } = harness({ enabled: false, sets: [offered()], queue })
    const set = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    await expect(
      decideNextStepStart(service, set.id, { action: 'run', suggestionIds: ['c1'] }, source())
    ).rejects.toThrow(NEXT_STEP_START_NOT_FRESH)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('keeps a replacement made in the same millisecond answerable, and retires its predecessor', async () => {
    const { service, store, enqueue } = harness({ enabled: false, sets: [offered()] })
    const first = suggestNextStepStart(service, { worktreeId: WT }, NOW).set!
    const second = suggestNextStepStart(service, { worktreeId: WT, force: true }, NOW).set!
    expect(second.createdAt).toBeGreaterThan(first.createdAt)
    expect(store.get(first.id)?.status).toBe('superseded')
    expect(suggestNextStepStart(service, { worktreeId: WT }, NOW).set?.id).toBe(second.id)
    await expect(
      decideNextStepStart(service, second.id, { action: 'run', suggestionIds: ['c1'] }, source())
    ).resolves.toMatchObject({ queued: ['c1'] })
    expect(enqueue).toHaveBeenCalledTimes(1)
  })
})
