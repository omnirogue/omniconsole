import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextStepSuggestion, NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import { decideNextSteps } from './next-step-decisions'
import { currentReplyDecisions } from './next-step-current-decisions'
import { setNextStepKeepGoingController } from './next-step-suggestion-slot'
import type { NextStepKeepGoingController } from './next-step-keep-going'
import {
  NextStepSuggestionService,
  type NextStepGenerateOutcome
} from './next-step-suggestion-service'
import {
  currentNextSteps,
  NEXT_STEP_EARLIER_TURN_REASON,
  NEXT_STEP_TURN_ANSWERED_REASON,
  NEXT_STEP_TURN_UNCONFIRMED_REASON,
  offerParsedForReply,
  registerParsedNextSteps
} from './next-step-turn-answers'
import { NEXT_STEP_SETS_FILE, NextStepSuggestionStore } from './next-step-suggestion-store'
import type { FinishedTurn } from './next-step-turn-signal'
import { createNextStepReplyPtyProof } from '../../shared/next-step-reply-proof'
import { conversationSourceRowKey } from '../../shared/conversation-source'

const conversation = { worktreeId: 'repo::/w', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const REPLY = 'Done.\n\nNext steps:\n1. Review the PR\n2. Update the changelog'
const turn = (turnKey: string, lastAssistantMessage = REPLY): FinishedTurn => ({
  conversation,
  turnKey,
  agent: 'claude',
  lastAssistantMessage
})
const parsedSteps: NextStepSuggestion[] = ['Review the PR', 'Update the changelog'].map(
  (title, index) => ({
    id: `s${index + 1}`,
    title,
    prompt: `Please go ahead with this next step you suggested: ${title}`,
    risk: 'safe',
    kind: 'review'
  })
)
const ok = (): NextStepGenerateOutcome => ({
  ok: true,
  suggestions: [
    { id: 'a1', title: 'Run tests', prompt: 'Run the tests.', risk: 'safe', kind: 'verify' }
  ]
})

let dir: string
let store: NextStepSuggestionStore
let pending: { resolve: (outcome: NextStepGenerateOutcome) => void; signal: AbortSignal }[]

function harness(readLatestTurn?: () => Promise<FinishedTurn | null>) {
  store = new NextStepSuggestionStore({ directory: dir })
  pending = []
  let ids = 0
  const service = new NextStepSuggestionService({
    store,
    settings: () => ({ enabled: true }),
    readPromptQueue: () => null,
    isChainBound: () => false,
    enqueue: vi.fn(),
    generate: (_turn, signal) =>
      new Promise<NextStepGenerateOutcome>((resolve) => pending.push({ resolve, signal })),
    ...(readLatestTurn ? { readLatestTurn } : {}),
    newId: () => `set-${++ids}`
  })
  service.deps.readReplyDecisionPtyProof = (source) => {
    const current = service.currentTurns.get(conversationSourceRowKey(source))?.turn
    return current ? ownerProof(current) : null
  }
  return service
}

const ownerProof = (current: FinishedTurn) =>
  createNextStepReplyPtyProof(current.turnKey, {
    providerSession: { key: 'session_id', id: 'current-provider' },
    lastAssistantMessage: current.lastAssistantMessage
  })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'next-steps-current-'))
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(async () => {
  setNextStepKeepGoingController(null)
  vi.useRealTimers()
  await store.flush()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const parsedOf = (turnKey: string) =>
  store.list().find((set) => set.origin === 'parsed' && set.turnKey === turnKey)!

describe('current turn', () => {
  it('rechecks queued answers and owner activity after an asynchronous cold turn read', async () => {
    const latest: FinishedTurn = {
      ...turn('t1', 'Should I build it?'),
      completedAt: 100,
      order: 100,
      replyComplete: true
    }
    let release!: (turn: FinishedTurn) => void
    const service = harness(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    let idle = true
    service.deps.readReplyDecisionPtyProof = () => ownerProof(latest)
    service.deps.listReplyDecisionSources = () => (idle ? [conversation] : [])
    const pendingProjection = currentReplyDecisions(service, [])
    service.deps.readPromptQueue = () => ({
      source: conversation,
      entries: [{ id: 'answer', text: 'Yes, build it.', createdAt: 101, state: 'queued' }]
    })
    release(latest)
    expect(await pendingProjection).toEqual([])
    service.deps.readPromptQueue = () => null
    const whileSubmitting = currentReplyDecisions(service, service.list().sets)
    idle = false
    expect(await whileSubmitting).toEqual([])
  })
  it('repairs only the malformed pending menu under a new id with Keep going off', async () => {
    const service = harness()
    const latest: FinishedTurn = {
      ...turn(
        't1',
        '1. **Close the idle sessions**. Recommended.\n2. Leave everything as it is.\n\nReply 1 or 2.'
      ),
      completedAt: 100,
      order: 100,
      replyComplete: true
    }
    service.onFinishedTurn(latest)
    const parsed = parsedOf('t1')
    store.update(parsed.id, (set) => ({
      ...set,
      suggestions: [{ ...set.suggestions[0]!, title: 'Recommended.' }]
    }))
    let enabled = true
    setNextStepKeepGoingController({
      list: () => [{ enabled }]
    } as unknown as NextStepKeepGoingController)
    await currentReplyDecisions(service, service.list().sets)
    expect(store.get(parsed.id)?.status).toBe('pending')
    enabled = false
    expect(await currentReplyDecisions(service, service.list().sets)).toHaveLength(1)
    expect(store.get(parsed.id)?.status).toBe('superseded')
    const repaired = (await currentNextSteps(service, conversation)).parsed!
    expect(repaired.id).not.toBe(parsed.id)
    expect(repaired.suggestions.map((step) => step.title)).toEqual([
      'Close the idle sessions',
      'Leave everything as it is.'
    ])
    await expect(
      decideNextSteps(service, parsed.id, { action: 'run', suggestionIds: ['s1'] })
    ).rejects.toThrow('superseded')
    expect(service.deps.enqueue).not.toHaveBeenCalled()
    await decideNextSteps(service, repaired.id, { action: 'dismiss' })
    expect(await currentReplyDecisions(service, service.list().sets)).toEqual([])
    expect(store.list().filter((set) => set.origin === 'parsed')).toHaveLength(2)
  })
  it('discovers an unanswered current question after restart without opening its pane', async () => {
    const question = 'Should I build and check the picker before the next install?'
    const latest: FinishedTurn = {
      ...turn('t1', question),
      completedAt: 100,
      order: 100,
      replyComplete: true
    }
    const read = vi.fn(async () => latest)
    const service = harness(read)
    service.deps.readReplyDecisionPtyProof = () => ownerProof(latest)
    service.deps.listReplyDecisionSources = () => [conversation]
    expect(store.list()).toEqual([])
    expect(await currentReplyDecisions(service, service.list().sets)).toEqual([
      { conversation, turnKey: 't1', completedAt: 100, question, ptyProof: ownerProof(latest) }
    ])
    await currentReplyDecisions(service, service.list().sets)
    expect(read).toHaveBeenCalledTimes(1)
    service.deps.readPromptQueue = () => ({
      source: conversation,
      entries: [{ id: 'answer', text: 'Yes, build it.', createdAt: 101, state: 'queued' }]
    })
    expect(await currentReplyDecisions(service, service.list().sets)).toEqual([])
    service.deps.readPromptQueue = () => null
    // A newly submitted user turn removes the source from the owner's idle snapshots.
    service.deps.listReplyDecisionSources = () => []
    expect(await currentReplyDecisions(service, service.list().sets)).toEqual([])
    service.deps.listReplyDecisionSources = () => [conversation]
    await decideNextSteps(service, parsedOf('t1').id, { action: 'dismiss' })
    expect(await currentReplyDecisions(service, service.list().sets)).toEqual([])
  })

  it('refuses a changed owner provider, turn or reply during cold recovery', async () => {
    const latest: FinishedTurn = {
      ...turn('t1', 'Should I build it?'),
      completedAt: 100,
      order: 100,
      replyComplete: true
    }
    let release!: (value: FinishedTurn) => void
    const service = harness(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    let proof = ownerProof(latest)!
    service.deps.listReplyDecisionSources = () => [conversation]
    service.deps.readReplyDecisionPtyProof = () => proof
    const reading = currentReplyDecisions(service, [])
    proof = { ...proof, providerSession: { key: 'session_id', id: 'replacement' } }
    release(latest)
    expect(await reading).toEqual([])
    proof = { ...proof, turnKey: 'new-owner-turn' }
    expect(await currentReplyDecisions(service, service.list().sets)).toEqual([])
    proof = createNextStepReplyPtyProof('t1', {
      providerSession: proof.providerSession,
      lastAssistantMessage: 'Should I deploy it?'
    })!
    expect(await currentReplyDecisions(service, service.list().sets)).toEqual([])
  })

  it('drops old questions and never promotes optional offers, failed reads or partial replies', async () => {
    vi.useFakeTimers()
    const service = harness()
    service.onFinishedTurn({
      ...turn('t1', 'Should I build it?'),
      completedAt: 100,
      order: 100,
      replyComplete: true
    })
    expect(await currentReplyDecisions(service, service.list().sets)).toHaveLength(1)
    service.onFinishedTurn({
      ...turn('t2', 'If you want, I can also review it.'),
      completedAt: 200,
      order: 200,
      replyComplete: true
    })
    expect(await currentReplyDecisions(service, service.list().sets)).toEqual([])
    service.onFinishedTurn({ ...turn('t3', 'Should I build it?'), completedAt: 300, order: 300 })
    expect(await currentReplyDecisions(service, service.list().sets)).toEqual([])
    service.currentTurns.clear()
    service.deps.readLatestTurn = async () => {
      throw new Error('unavailable')
    }
    expect(await currentReplyDecisions(service, service.list().sets)).toEqual([])
  })
  it('returns only the latest observed turn; a skipped newer turn retires the older sets', async () => {
    vi.useFakeTimers()
    const service = harness()
    service.onFinishedTurn(turn('t1', 'Done.'))
    await vi.advanceTimersByTimeAsync(1_500)
    service.onTurnSignal({ kind: 'skip', conversation, turnKey: 't2', reason: 'queued' })
    expect(pending[0]!.signal.aborted).toBe(true)
    const current = await currentNextSteps(service, conversation)
    expect(current).toMatchObject({ turnKey: 't2', answered: false, turnObserved: true })
    expect(current.ai).toBeUndefined()
    expect(current.parsed).toBeUndefined()
    expect(store.list().every((set) => set.status === 'superseded')).toBe(true)
  })

  it('reads the latest turn back after a restart, with its reply’s own steps', async () => {
    const service = harness(async () => turn('t9'))
    const current = await currentNextSteps(service, conversation)
    expect(current).toMatchObject({ turnKey: 't9', parsed: { turnKey: 't9', status: 'pending' } })
  })
})

describe('the host reads the reply’s own steps', () => {
  it('the reply’s own steps are the turn’s set: no AI call is ever started for them', async () => {
    vi.useFakeTimers()
    const service = harness()
    expect(service.onFinishedTurn(turn('t1')).set).toMatchObject({ origin: 'parsed' })
    expect(parsedOf('t1')).toMatchObject({ status: 'pending' })
    expect(parsedOf('t1').suggestions.map((step) => [step.id, step.title])).toEqual([
      ['s1', 'Review the PR'],
      ['s2', 'Update the changelog']
    ])
    await vi.advanceTimersByTimeAsync(1_500)
    service.onFinishedTurn(turn('t1'))
    await vi.runAllTimersAsync()
    expect(pending).toHaveLength(0)
    const current = await currentNextSteps(service, conversation)
    expect(current).toMatchObject({ parsed: { status: 'pending' } })
    expect(current.ai).toBeUndefined()
  })

  it('a reply with no steps of its own gets the AI call', async () => {
    vi.useFakeTimers()
    const service = harness()
    service.onFinishedTurn(turn('t1', 'Done, nothing proposed.'))
    await vi.advanceTimersByTimeAsync(1_500)
    expect(pending).toHaveLength(1)
    expect(await currentNextSteps(service, conversation)).toMatchObject({
      ai: { status: 'generating' }
    })
  })

  it('asking for more adds the AI’s steps beside the reply’s, never in place of them', async () => {
    vi.useFakeTimers()
    const service = harness()
    service.onFinishedTurn(turn('t1'))
    const asked = await service.generate(conversation)
    expect(asked.set).toMatchObject({ origin: 'ai', status: 'generating' })
    expect(pending).toHaveLength(1)
    pending[0]!.resolve(ok())
    await vi.runAllTimersAsync()
    const current = await currentNextSteps(service, conversation)
    expect(current).toMatchObject({
      answered: false,
      ai: { status: 'pending' },
      parsed: { status: 'pending' }
    })
    // Dismissing the extra ideas leaves the reply's own steps open and the turn unanswered.
    await decideNextSteps(service, current.ai!.id, { action: 'dismiss' })
    expect(await currentNextSteps(service, conversation)).toMatchObject({
      answered: false,
      ai: { status: 'superseded' },
      parsed: { status: 'pending' }
    })
    await decideNextSteps(service, parsedOf('t1').id, { action: 'run', suggestionIds: ['s1'] })
    expect(await currentNextSteps(service, conversation)).toMatchObject({ answered: true })
  })

  it('a duplicate report of the same turn leaves its sets intact', async () => {
    vi.useFakeTimers()
    const service = harness()
    service.onFinishedTurn(turn('t1', 'Done.'))
    await vi.advanceTimersByTimeAsync(1_500)
    const before = store.list().map((set) => [set.id, set.status])
    service.onFinishedTurn(turn('t1', 'Done.'))
    service.onTurnSignal({ kind: 'skip', conversation, turnKey: 't1', reason: 'again' })
    expect(store.list().map((set) => [set.id, set.status])).toEqual(before)
    expect(pending[0]!.signal.aborted).toBe(false)
  })

  it('refuses an answer to a set from an older turn once a newer one finished', async () => {
    const service = harness()
    service.onFinishedTurn(turn('t1'))
    const older = parsedOf('t1')
    service.onFinishedTurn(turn('t2'))
    expect(store.get(older.id)!.status).toBe('superseded')
    // Even reopened by hand, an older turn's set can never be answered.
    store.update(older.id, (set) => ({ ...set, status: 'pending' }))
    await expect(decideNextSteps(service, older.id, { action: 'dismiss' })).rejects.toThrow(
      NEXT_STEP_EARLIER_TURN_REASON
    )
  })
})

describe('the fallback offer for an agent that reports no turns', () => {
  it('is kept under the reply’s own key until the first real turn supersedes it', async () => {
    const service = harness()
    const offered = await offerParsedForReply(service, conversation, 'm1', parsedSteps)
    expect(offered).toMatchObject({ turnKey: 'tab-1:leaf-1@reply:m1', messageId: 'm1' })
    expect(await currentNextSteps(service, conversation)).toMatchObject({
      turnKey: 'tab-1:leaf-1@reply:m1',
      turnObserved: false,
      parsed: { status: 'pending' }
    })
    service.onFinishedTurn(turn('t1'))
    expect(store.get((offered as NextStepSuggestionSet).id)!.status).toBe('superseded')
    expect(await offerParsedForReply(service, conversation, 'm2', parsedSteps)).toMatch(
      /reports its own turns/
    )
  })
})

describe('an answer settles the whole turn', () => {
  it('answering the parsed set aborts an asked-for AI call, and its late result never reopens the turn', async () => {
    vi.useFakeTimers()
    const service = harness()
    service.onFinishedTurn(turn('t1'))
    await service.generate(conversation)
    await decideNextSteps(service, parsedOf('t1').id, { action: 'run', suggestionIds: ['s1'] })
    const ai = store.list().find((set) => set.origin === 'ai')!
    expect(ai).toMatchObject({
      status: 'superseded',
      error: "Answered from the reply's own suggestions."
    })
    expect(pending[0]!.signal.aborted).toBe(true)
    pending[0]!.resolve(ok())
    await vi.runAllTimersAsync()
    expect(store.get(ai.id)!.status).toBe('superseded')
    expect(await currentNextSteps(service, conversation)).toMatchObject({ answered: true })
    service.onFinishedTurn(turn('t1'))
    await vi.runAllTimersAsync()
    expect(pending).toHaveLength(1)
  })

  it('answering the parsed set during the debounce keeps the AI call from ever starting', async () => {
    vi.useFakeTimers()
    const service = harness()
    service.onFinishedTurn(turn('t1'))
    await decideNextSteps(service, parsedOf('t1').id, { action: 'dismiss' })
    await vi.advanceTimersByTimeAsync(1_500)
    expect(pending).toHaveLength(0)
    expect(store.list().filter((set) => set.origin === 'ai')).toEqual([])
  })

  it('an answered AI set leaves the reply’s steps settled for the log only', async () => {
    vi.useFakeTimers()
    const service = harness()
    service.onFinishedTurn(turn('t1', 'Done, nothing proposed.'))
    await vi.advanceTimersByTimeAsync(1_500)
    pending[0]!.resolve(ok())
    await vi.runAllTimersAsync()
    const ai = store.list().find((set) => set.origin === 'ai')!
    await decideNextSteps(service, ai.id, { action: 'dismiss' })
    const parsed = registerParsedNextSteps(service, conversation, 't1', parsedSteps)
    expect(parsed).toMatchObject({ status: 'superseded', error: NEXT_STEP_TURN_ANSWERED_REASON })
    expect(await currentNextSteps(service, conversation)).toMatchObject({ answered: true })
  })
})

describe('round 4', () => {
  const placed = (turnKey: string, order: number, text = REPLY): FinishedTurn => ({
    ...turn(turnKey, text),
    order,
    completedAt: order
  })

  it('carries an answered fallback over to the first real turn: answered, no second offer, no AI', async () => {
    vi.useFakeTimers()
    const service = harness()
    const fallback = (await offerParsedForReply(
      service,
      conversation,
      'm1',
      parsedSteps
    )) as NextStepSuggestionSet
    await decideNextSteps(service, fallback.id, { action: 'run', suggestionIds: ['s1'] })
    // The real turn completed before the fallback was offered: it is the same reply.
    service.onFinishedTurn(placed('t1', fallback.createdAt - 1))
    await vi.advanceTimersByTimeAsync(1_500)
    expect(pending).toHaveLength(0)
    const current = await currentNextSteps(service, conversation)
    expect(current).toMatchObject({
      turnKey: 't1',
      answered: true,
      parsed: { status: 'accepted', error: "Answered from the reply's own suggestions." }
    })
    expect(current.ai).toBeUndefined()
  })

  it('an unanswered fallback is superseded by the first real turn as before', async () => {
    const service = harness()
    const fallback = (await offerParsedForReply(
      service,
      conversation,
      'm1',
      parsedSteps
    )) as NextStepSuggestionSet
    service.onFinishedTurn(placed('t1', fallback.createdAt - 1))
    expect(store.get(fallback.id)!.status).toBe('superseded')
    expect(await currentNextSteps(service, conversation)).toMatchObject({
      answered: false,
      parsed: { turnKey: 't1', status: 'pending' }
    })
  })

  it('a replayed older turn never becomes current, supersedes nothing and aborts nothing', async () => {
    vi.useFakeTimers()
    const service = harness()
    service.onFinishedTurn(placed('t2', 200, 'Done.'))
    await vi.advanceTimersByTimeAsync(1_500)
    const before = store.list().map((set) => [set.id, set.status])
    expect(service.onFinishedTurn(placed('t1', 100))).toMatchObject({ set: null })
    service.onTurnSignal({
      kind: 'skip',
      conversation,
      turnKey: 't0',
      reason: 'replayed',
      order: 50
    })
    expect(store.list().map((set) => [set.id, set.status])).toEqual(before)
    expect(pending[0]!.signal.aborted).toBe(false)
    expect((await currentNextSteps(service, conversation)).turnKey).toBe('t2')
  })

  it('a skipped newer turn makes answers to the older sets refused', async () => {
    const service = harness()
    service.onFinishedTurn(placed('t1', 100))
    const older = parsedOf('t1')
    service.onTurnSignal({
      kind: 'skip',
      conversation,
      turnKey: 't2',
      reason: 'failed',
      order: 200
    })
    store.update(older.id, (set) => ({ ...set, status: 'pending' }))
    await expect(decideNextSteps(service, older.id, { action: 'dismiss' })).rejects.toThrow(
      NEXT_STEP_EARLIER_TURN_REASON
    )
  })

  it('refuses a turn set that has no conversation', async () => {
    const service = harness()
    const orphan = store.upsert({
      ...service.newSet({ conversation, turnKey: 't1' }, 'ai', 'pending', parsedSteps),
      conversation: undefined
    })
    await expect(decideNextSteps(service, orphan.id, { action: 'dismiss' })).rejects.toThrow(
      /no conversation/
    )
  })

  it('an unreadable latest turn is unknown, not "never seen": no fallback is taken', async () => {
    const service = harness(async () => {
      throw new Error('journal unavailable')
    })
    expect(await currentNextSteps(service, conversation)).toMatchObject({ turnObserved: null })
    expect(await offerParsedForReply(service, conversation, 'm1', parsedSteps)).toMatch(
      /could not be read/
    )
  })

  it('reports the current turn’s completion time for the client’s staleness check', async () => {
    const service = harness()
    service.onFinishedTurn(placed('t1', 1_700_000_000_000))
    expect(await currentNextSteps(service, conversation)).toMatchObject({
      turnCompletedAt: 1_700_000_000_000
    })
  })
})

describe('round 5', () => {
  const placed = (turnKey: string, order: number): FinishedTurn => ({
    ...turn(turnKey),
    order,
    completedAt: order
  })

  it('refuses to answer a set whose ids repeat', async () => {
    const service = harness()
    service.onFinishedTurn(placed('t1', 1))
    const doubled = store.upsert(
      service.newSet({ conversation, turnKey: 't1' }, 'ai', 'pending', [
        parsedSteps[0]!,
        { ...parsedSteps[1]!, id: parsedSteps[0]!.id, risk: 'risky' }
      ])
    )
    await expect(
      decideNextSteps(service, doubled.id, { action: 'run', suggestionIds: ['s1'] })
    ).rejects.toThrow(/repeat an id/)
  })

  it('drops a saved set with repeated ids when the store loads', async () => {
    const service = harness()
    service.onFinishedTurn(placed('t1', 1))
    const saved = parsedOf('t1')
    await store.flush()
    const file = join(dir, NEXT_STEP_SETS_FILE)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.sets[0].suggestions[1].id = raw.sets[0].suggestions[0].id
    writeFileSync(file, JSON.stringify(raw))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reloaded = new NextStepSuggestionStore({ directory: dir })
    reloaded.load()
    expect(reloaded.get(saved.id)).toBeUndefined()
  })

  it('after a restart whose turn read fails, offers nothing and refuses any answer', async () => {
    // A set saved before the restart…
    const before = harness()
    before.onFinishedTurn(placed('t1', 1))
    const saved = parsedOf('t1')
    await store.flush()
    // …and a restarted host that cannot read the latest turn back.
    const failingStore = new NextStepSuggestionStore({ directory: dir })
    failingStore.load()
    const restarted = new NextStepSuggestionService({
      store: failingStore,
      settings: () => ({ enabled: true }),
      readPromptQueue: () => null,
      isChainBound: () => false,
      enqueue: vi.fn(),
      generate: vi.fn(),
      readLatestTurn: async () => {
        throw new Error('journal unavailable')
      }
    })
    expect(failingStore.get(saved.id)?.status).toBe('pending')
    const current = await currentNextSteps(restarted, conversation)
    expect(current).toMatchObject({ turnKey: null, turnObserved: null, answered: false })
    expect(current.parsed).toBeUndefined()
    await expect(decideNextSteps(restarted, saved.id, { action: 'dismiss' })).rejects.toThrow(
      NEXT_STEP_TURN_UNCONFIRMED_REASON
    )
    await failingStore.flush()
  })

  it('a forced suggestion from a second window never reopens a turn the first answered', async () => {
    vi.useFakeTimers()
    const service = harness()
    service.onFinishedTurn(placed('t1', 1))
    // Window A answers the reply's own steps.
    await decideNextSteps(service, parsedOf('t1').id, { action: 'dismiss' })
    // Window B, still showing the tray, forces a new suggestion for the same turn.
    expect(await service.generate(conversation, { force: true })).toEqual({
      set: null,
      skipped: NEXT_STEP_TURN_ANSWERED_REASON
    })
    await vi.advanceTimersByTimeAsync(1_500)
    expect(pending).toHaveLength(0)
    expect(await currentNextSteps(service, conversation)).toMatchObject({ answered: true })
  })

  it('refuses an open set on a turn another answer already settled', async () => {
    const service = harness()
    service.onFinishedTurn(placed('t1', 1))
    const parsed = parsedOf('t1')
    await decideNextSteps(service, parsed.id, { action: 'dismiss' })
    const late = store.upsert(
      service.newSet({ conversation, turnKey: 't1' }, 'ai', 'pending', parsedSteps)
    )
    await expect(decideNextSteps(service, late.id, { action: 'dismiss' })).rejects.toThrow(
      NEXT_STEP_TURN_ANSWERED_REASON
    )
  })

  it('a late older report does not change which turn "Suggest next steps" answers', async () => {
    const service = harness()
    service.onFinishedTurn(placed('t2', 200))
    service.onFinishedTurn(placed('t1', 100))
    const result = await service.generate(conversation, { force: true })
    expect(result.set).toMatchObject({ turnKey: 't2', origin: 'ai' })
  })
})
