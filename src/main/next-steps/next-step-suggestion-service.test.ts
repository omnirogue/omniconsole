import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import type { NextStepSuggestion } from '../../shared/next-step-suggestions'
import type { PromptQueue } from '../../shared/prompt-queue-types'
import {
  NextStepSuggestionService,
  type NextStepGenerateOutcome
} from './next-step-suggestion-service'
import { NextStepSuggestionStore } from './next-step-suggestion-store'
import { classifyHookTurnSignal, type FinishedTurn } from './next-step-turn-signal'

let dir: string
let ids = 0
const stores: NextStepSuggestionStore[] = []

const source = (paneKey = 'tab-1:leaf-1', worktreeId = 'repo::/w'): ConversationSource => ({
  worktreeId,
  paneKey,
  kind: 'pty'
})

const turn = (over: Partial<FinishedTurn> = {}): FinishedTurn => ({
  conversation: source(),
  turnKey: 'tab-1:leaf-1@1',
  agent: 'claude',
  lastAssistantMessage: 'I changed the parser.',
  ...over
})

const suggestion = (id: string, risk: 'safe' | 'risky' = 'safe'): NextStepSuggestion => ({
  id,
  title: `Step ${id}`,
  prompt: `Do step ${id}.`,
  risk,
  kind: 'continue'
})

type Pending = {
  turn: FinishedTurn
  signal: AbortSignal
  resolve: (outcome: NextStepGenerateOutcome) => void
}

function harness(
  options: {
    enabled?: boolean
    queue?: PromptQueue | null
    chainBound?: boolean
  } = {}
) {
  const store = new NextStepSuggestionStore({ directory: dir })
  stores.push(store)
  const calls: Pending[] = []
  const generate = vi.fn(
    (t: FinishedTurn, signal: AbortSignal) =>
      new Promise<NextStepGenerateOutcome>((resolve) => {
        calls.push({ turn: t, signal, resolve })
      })
  )
  const service = new NextStepSuggestionService({
    store,
    settings: () => ({ enabled: options.enabled ?? true }),
    readPromptQueue: () => options.queue ?? null,
    isChainBound: () => options.chainBound ?? false,
    enqueue: vi.fn(),
    generate,
    newId: () => `set-${++ids}`
  })
  return { store, service, calls, generate }
}

const ok = (...suggestionIds: string[]): NextStepGenerateOutcome => ({
  ok: true,
  suggestions: suggestionIds.map((id) => suggestion(id)),
  model: 'sonnet'
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'next-steps-service-'))
  vi.useFakeTimers()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(stores.splice(0).map((store) => store.flush()))
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('turn-end trigger', () => {
  it('a Claude Stop and a Codex Stop both produce one generation after the debounce', async () => {
    const { service, calls, store } = harness()
    for (const [paneKey, agent, worktreeId] of [
      ['tab-1:leaf-1', 'claude', 'repo::/w'],
      ['tab-2:leaf-1', 'codex', 'repo::/w2']
    ] as const) {
      service.onTurnSignal(
        classifyHookTurnSignal({
          paneKey,
          worktreeId,
          hookEventName: 'Stop',
          stateStartedAt: 7,
          payload: { state: 'done', agentType: agent, lastAssistantMessage: 'Done.' }
        })
      )
    }
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(calls.map((call) => call.turn.agent)).toEqual(['claude', 'codex'])
    expect(store.list().every((set) => set.status === 'generating')).toBe(true)
    calls[0]!.resolve(ok('s1', 's2', 's3'))
    await vi.runAllTimersAsync()
    const claude = service.list({ conversation: source('tab-1:leaf-1') }).sets[0]!
    expect(claude).toMatchObject({ origin: 'ai', status: 'pending', model: 'sonnet' })
    expect(claude.suggestions).toHaveLength(3)
  })

  it('one turn yields one set even when its done row is reported twice', async () => {
    const { service, calls } = harness()
    service.onFinishedTurn(turn())
    await vi.advanceTimersByTimeAsync(1_500)
    calls[0]!.resolve(ok('s1'))
    await vi.runAllTimersAsync()
    service.onFinishedTurn(turn())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toHaveLength(1)
    expect(service.list().sets).toHaveLength(1)
  })

  it('the pane going busy during the wait cancels it, and says so', async () => {
    const { service, calls } = harness()
    service.onFinishedTurn(turn())
    await vi.advanceTimersByTimeAsync(1_000)
    service.noteBusy(source())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toHaveLength(0)
    expect(service.list().skips[0]!.reason).toMatch(/started working again/)
  })
})

describe('skip rules — each records its reason', () => {
  it.each([
    [{ enabled: false }, /turned off in settings/],
    [
      {
        queue: {
          source: source(),
          entries: [{ id: 'q', text: 'next', createdAt: 1, state: 'queued' as const }]
        }
      },
      /already queued/
    ],
    [{ chainBound: true }, /running plan/]
  ])('%o', async (options, reason) => {
    const { service, calls } = harness(options)
    const result = service.onFinishedTurn(turn())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toHaveLength(0)
    expect(result).toEqual({ set: null, skipped: expect.stringMatching(reason) })
    expect(service.list().skips).toMatchObject([{ reason: expect.stringMatching(reason) }])
    expect(service.list().sets).toEqual([])
  })

  it('a failed turn is recorded, not generated', async () => {
    const { service, calls } = harness()
    service.onTurnSignal(
      classifyHookTurnSignal({
        paneKey: 'tab-1:leaf-1',
        worktreeId: 'repo::/w',
        hookEventName: 'StopFailure',
        stateStartedAt: 1,
        payload: { state: 'done', failed: true, failureReason: 'rate limit' }
      })
    )
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toHaveLength(0)
    expect(service.list().skips[0]!.reason).toMatch(/stopped without finishing: rate limit/)
  })

  it('a runner that cannot run on this host fails the set in plain words', async () => {
    const { service, calls } = harness()
    service.onFinishedTurn(turn())
    await vi.advanceTimersByTimeAsync(1_500)
    calls[0]!.resolve({ ok: false, error: 'this workspace lives on a paired host.' })
    await vi.runAllTimersAsync()
    expect(service.list().sets[0]).toMatchObject({
      status: 'failed',
      error: 'this workspace lives on a paired host.'
    })
  })

  it('the manual generate obeys the rules unless forced, and skips the debounce', async () => {
    const { service, calls } = harness({ enabled: false })
    service.onFinishedTurn(turn())
    expect(await service.generate(source())).toMatchObject({ set: null })
    const forced = await service.generate(source(), { force: true })
    expect(forced.set).toMatchObject({ status: 'generating', origin: 'ai' })
    expect(calls).toHaveLength(1)
    expect(await service.generate(source('tab-9:leaf-9'))).toMatchObject({
      set: null,
      skipped: expect.stringMatching(/no finished reply/)
    })
  })
})

describe('scheduling', () => {
  it('a newer turn supersedes the older set and aborts its call', async () => {
    const { service, calls, store } = harness()
    service.onFinishedTurn(turn())
    await vi.advanceTimersByTimeAsync(1_500)
    const older = store.list()[0]!
    service.onFinishedTurn(turn({ turnKey: 'tab-1:leaf-1@2' }))
    expect(store.get(older.id)!.status).toBe('superseded')
    expect(calls[0]!.signal.aborted).toBe(true)
    calls[0]!.resolve(ok('s1'))
    await vi.advanceTimersByTimeAsync(1_500)
    calls[1]!.resolve(ok('s1', 's2'))
    await vi.runAllTimersAsync()
    expect(store.get(older.id)!.status).toBe('superseded')
    expect(service.list().sets[0]).toMatchObject({ turnKey: 'tab-1:leaf-1@2', status: 'pending' })
  })

  it('lists only the asked-for statuses', async () => {
    const { service, calls } = harness()
    service.onFinishedTurn(turn())
    await vi.advanceTimersByTimeAsync(1_500)
    service.onFinishedTurn(turn({ turnKey: 'tab-1:leaf-1@2' }))
    calls[0]!.resolve(ok('s1'))
    await vi.advanceTimersByTimeAsync(1_500)
    calls[1]!.resolve(ok('s1'))
    await vi.runAllTimersAsync()
    expect(
      service
        .list()
        .sets.map((set) => set.status)
        .sort()
    ).toEqual(['pending', 'superseded'])
    expect(service.list({ statuses: ['pending'] }).sets).toMatchObject([
      { turnKey: 'tab-1:leaf-1@2', status: 'pending' }
    ])
  })

  it('runs at most two generations at once across conversations', async () => {
    const { service, calls } = harness()
    for (const index of [1, 2, 3]) {
      service.onFinishedTurn(
        turn({
          conversation: source(`tab-${index}:leaf`, `repo::/w${index}`),
          turnKey: `t${index}`
        })
      )
    }
    await vi.advanceTimersByTimeAsync(1_500)
    expect(calls).toHaveLength(2)
    calls[0]!.resolve(ok('s1'))
    await vi.runAllTimersAsync()
    expect(calls).toHaveLength(3)
  })

  it('closing the working pane aborts its call and drops the unfinished set', async () => {
    const { service, calls, store } = harness()
    service.onFinishedTurn(turn())
    await vi.advanceTimersByTimeAsync(1_500)
    service.onPaneClosed('tab-1:leaf-1')
    expect(calls[0]!.signal.aborted).toBe(true)
    expect(store.list()).toEqual([])
    calls[0]!.resolve(ok('s1'))
    await vi.runAllTimersAsync()
    expect(store.list()).toEqual([])
  })

  it('superseding or closing one conversation never cancels another in the same workspace', async () => {
    const { service, calls } = harness()
    const a = source('tab-a:leaf')
    const b = source('tab-b:leaf')
    service.onFinishedTurn(turn({ conversation: a, turnKey: 'a@1' }), { immediate: true })
    service.onFinishedTurn(turn({ conversation: b, turnKey: 'b@1' }), { immediate: true })
    // Same workspace lane: B waits for A rather than sharing its cancel key.
    expect(calls.map((call) => call.turn.turnKey)).toEqual(['a@1'])
    service.onFinishedTurn(turn({ conversation: a, turnKey: 'a@2' }), { immediate: true })
    expect(calls[0]!.signal.aborted).toBe(true)
    calls[0]!.resolve(ok('s1'))
    await vi.runAllTimersAsync()
    const bCall = calls.find((call) => call.turn.turnKey === 'b@1')!
    expect(bCall.signal.aborted).toBe(false)
    service.onPaneClosed('tab-a:leaf')
    service.onFinishedTurn(turn({ conversation: a, turnKey: 'a@3' }), { immediate: true })
    expect(bCall.signal.aborted).toBe(false)
    bCall.resolve(ok('s1'))
    await vi.runAllTimersAsync()
    expect(service.list({ conversation: b }).sets[0]).toMatchObject({ status: 'pending' })
  })

  it('busy drops a generation still queued behind the cap, with its empty set', async () => {
    const { service, calls, store } = harness()
    for (const index of [1, 2, 3]) {
      service.onFinishedTurn(
        turn({
          conversation: source(`tab-${index}:leaf`, `repo::/w${index}`),
          turnKey: `t${index}`
        }),
        { immediate: true }
      )
    }
    expect(calls).toHaveLength(2)
    expect(store.list().filter((set) => set.status === 'generating')).toHaveLength(3)
    service.noteBusy(source('tab-3:leaf', 'repo::/w3'))
    expect(store.list().filter((set) => set.status === 'generating')).toHaveLength(2)
    calls[0]!.resolve(ok('s1'))
    await vi.runAllTimersAsync()
    expect(calls).toHaveLength(2)
    expect(service.list().skips[0]!.reason).toMatch(/started working again/)
  })
})

describe('manual generate', () => {
  it('regenerates a failed set, and returns an open one as it is', async () => {
    const { service, calls } = harness()
    service.onFinishedTurn(turn(), { immediate: true })
    calls[0]!.resolve({ ok: false, error: 'timed out' })
    await vi.runAllTimersAsync()
    // A hook re-reporting the failed turn does not loop the call…
    service.onFinishedTurn(turn())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toHaveLength(1)
    // …but the person asking again does.
    const retried = await service.generate(source())
    expect(retried.set).toMatchObject({ status: 'generating' })
    expect(calls).toHaveLength(2)
    const again = await service.generate(source())
    expect(again.set!.id).toBe(retried.set!.id)
    expect(calls).toHaveLength(2)
  })
})
