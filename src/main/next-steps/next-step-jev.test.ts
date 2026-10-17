import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleTaskCard, ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import type { ConversationSource } from '../../shared/conversation-source'
import type { NextStepSuggestionSettings } from '../../shared/next-step-suggestion-settings'
import type { NextStepSuggestion } from '../../shared/next-step-suggestions'
import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import { NextStepJev } from './next-step-jev'
import { NextStepDonenessCache } from './next-step-jev-doneness'
import { NextStepSuggestionService } from './next-step-suggestion-service'
import { NextStepSuggestionStore } from './next-step-suggestion-store'
import type { FinishedTurn } from './next-step-turn-signal'
import {
  currentNextSteps,
  observeNextStepTurn,
  registerParsedNextSteps
} from './next-step-turn-answers'

let dir: string
const stores: NextStepSuggestionStore[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'next-step-jev-'))
})
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.flush()))
  rmSync(dir, { recursive: true, force: true })
})

const conversation: ConversationSource = { worktreeId: 'repo::/w', paneKey: 'tab:1', kind: 'pty' }
const turn = (over: Partial<FinishedTurn> = {}): FinishedTurn => ({
  conversation,
  turnKey: 'tab:1@1',
  agent: 'claude',
  lastAssistantMessage: 'I fixed the parser and ran the tests.',
  lastUserPrompt: 'Fix the parser',
  ...over
})
const step = (id: string): NextStepSuggestion => ({
  id,
  title: `Step ${id}`,
  prompt: `Do step ${id}.`,
  risk: 'safe',
  kind: 'continue'
})

// JEV prefers the second step, flags the first as risky, and reads the work as done.
const ANSWERS: Record<string, number> = {
  'step_1.valuable': 0.1,
  'step_1.specific': 0.1,
  'step_1.grounded': 0.1,
  'step_1.not_done': 0.1,
  'step_1.risk': 0.9,
  'step_2.valuable': 0.95,
  'step_2.specific': 0.95,
  'step_2.grounded': 0.95,
  'step_2.not_done': 0.95,
  'step_2.risk': 0.05,
  resolved: 0.95,
  remaining_work: 0.05,
  room_to_improve: 0.1,
  verified: 0.9
}

function setup(initial: NextStepSuggestionSettings = { enabled: true }) {
  let settings = initial
  const evaluate = vi.fn(async (request: DecisionRequest): Promise<DecisionResult> => ({
    provider: 'typesafe',
    model: 'jev-1.13.0',
    usage: { inputTokens: 1, outputTokens: 1 },
    answers: Object.fromEntries(
      Object.keys(request.questions).map((id) => [
        id,
        { type: 'noul' as const, noul: ANSWERS[id]! }
      ])
    )
  }))
  const readTaskCard = vi.fn(async (): Promise<ConsoleWorkflowResult<ConsoleTaskCard>> => ({
    ok: true,
    data: {
      id: 'btk_1',
      title: 'Ship the parser',
      nextAction: 'Run tests',
      status: null,
      ownerEmployeeId: null,
      companySlug: null,
      description: null,
      dueDate: null,
      updatedAt: null,
      blocked: false
    }
  }))
  const jev = new NextStepJev({
    settings: () => settings,
    readTaskCard,
    cache: new NextStepDonenessCache(),
    jev: { evaluate, credential: async () => 'k'.repeat(24), environment: {} }
  })
  const store = new NextStepSuggestionStore({ directory: dir, onChange: () => jev.onSetsChanged() })
  stores.push(store)
  let ids = 0
  const service = new NextStepSuggestionService({
    store,
    settings: () => settings,
    readPromptQueue: () => null,
    isChainBound: () => false,
    enqueue: vi.fn(),
    generate: vi.fn(),
    readDoneness: jev.readDoneness,
    newId: () => `set-${++ids}`
  })
  jev.attach(service)
  const doneness = () => evaluate.mock.calls.filter(([r]) => 'resolved' in r.questions).length
  const switchTo = (next: NextStepSuggestionSettings) => {
    settings = next
  }
  return { jev, store, service, evaluate, readTaskCard, doneness, switchTo }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('NextStepJev on the AI set', () => {
  it('ranks and risk-checks before the set is shown, and reads doneness alongside', async () => {
    const { jev, evaluate, doneness } = setup()
    const judged = await jev.judgeGenerated(
      turn(),
      { ok: true, suggestions: [step('a'), step('b')] },
      new AbortController().signal
    )
    expect(judged.ok && judged.suggestions.map((s) => [s.id, s.risk])).toEqual([
      ['b', 'safe'],
      ['a', 'risky']
    ])
    expect(judged.ok && judged.judged).toEqual({ rankedBy: 'jev', jevScores: { a: 0.1, b: 0.95 } })
    await settle()
    expect(doneness()).toBe(1)
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(jev.readDoneness('tab:1@1')).toMatchObject({ resolved: 0.95, unsure: false })
  })

  it('keeps the set as written when it is cancelled while JEV reads', async () => {
    const { jev } = setup()
    const controller = new AbortController()
    const outcome = { ok: true as const, suggestions: [step('a'), step('b')] }
    const judging = jev.judgeGenerated(turn(), outcome, controller.signal)
    controller.abort()
    expect(await judging).toBe(outcome)
  })

  it('honours each switch', async () => {
    const off = setup({ enabled: true, jev: { rank: false, risk: false, doneness: false } })
    const outcome = { ok: true as const, suggestions: [step('a'), step('b')] }
    expect(await off.jev.judgeGenerated(turn(), outcome, new AbortController().signal)).toBe(
      outcome
    )
    await settle()
    expect(off.evaluate).not.toHaveBeenCalled()
    expect(await off.jev.assessDoneness({ ...turn(), goal: 'g', replyTail: 'r' })).toBeNull()

    const riskOnly = setup({ enabled: true, jev: { rank: false, risk: true, doneness: true } })
    const judged = await riskOnly.jev.judgeGenerated(turn(), outcome, new AbortController().signal)
    expect(judged.ok && judged.suggestions.map((s) => s.id)).toEqual(['a', 'b'])
    expect(judged.ok && judged.suggestions[0]!.riskReason).toBe('jev')
    expect(judged.ok && judged.judged).toEqual({})
  })

  it('reads the goal from the linked card, else the first prompt this host saw', async () => {
    const { jev, readTaskCard } = setup()
    jev.noteTurn(turn({ lastUserPrompt: 'Fix the parser' }))
    jev.noteTurn(turn({ turnKey: 'tab:1@2', lastUserPrompt: 'Now add a test' }))
    const later = turn({ turnKey: 'tab:1@2', lastUserPrompt: 'Now add a test' })
    expect(await jev.goalFor(later)).toBe('Fix the parser')
    jev.linkTask(conversation, 'btk_1')
    expect(await jev.goalFor(later)).toBe('Ship the parser\nNext action: Run tests')
    jev.linkTask(conversation, null)
    expect(await jev.goalFor(later)).toBe('Fix the parser')
    expect(readTaskCard).toHaveBeenCalledTimes(1)
  })

  it('never takes a Keep going round as the goal', async () => {
    const { jev } = setup()
    const round = turn({ lastUserPrompt: '[Keep going 1/10 · kg-a1b2c3] Run the tests' })
    jev.noteTurn(round)
    expect(await jev.goalFor(round)).toBeNull()
    jev.noteTurn(turn({ turnKey: 'tab:1@2', lastUserPrompt: 'Fix the parser' }))
    expect(await jev.goalFor(round)).toBe('Fix the parser')
  })
})

describe('NextStepJev on the parsed set', () => {
  it('reorders an open parsed set once, and nextSteps.current carries doneness', async () => {
    const { jev, service, store, evaluate } = setup()
    observeNextStepTurn(service, conversation, 'tab:1@1', turn())
    const set = registerParsedNextSteps(service, conversation, 'tab:1@1', [step('a'), step('b')])
    await settle()
    expect(store.get(set.id)?.suggestions.map((s) => s.id)).toEqual(['b', 'a'])
    expect(store.get(set.id)?.rankedBy).toBe('jev')
    expect(evaluate).toHaveBeenCalledTimes(1)

    jev.assessTurn(turn())
    await settle()
    const current = await currentNextSteps(service, conversation)
    expect(current.parsed?.suggestions[0]!.id).toBe('b')
    expect(current.doneness).toMatchObject({ turnKey: 'tab:1@1', resolved: 0.95 })
  })

  it('leaves a set answered while JEV was reading untouched', async () => {
    const { service, store } = setup()
    observeNextStepTurn(service, conversation, 'tab:1@1', turn())
    const set = registerParsedNextSteps(service, conversation, 'tab:1@1', [step('a'), step('b')])
    store.update(set.id, (current) => ({ ...current, status: 'dismissed' }))
    await settle()
    expect(store.get(set.id)?.suggestions.map((s) => s.id)).toEqual(['a', 'b'])
    expect(store.get(set.id)?.rankedBy).toBeUndefined()
  })

  it('drops a late reading when a step was rewritten in place or JEV was switched off', async () => {
    const rewritten = setup()
    observeNextStepTurn(rewritten.service, conversation, 'tab:1@1', turn())
    const set = registerParsedNextSteps(rewritten.service, conversation, 'tab:1@1', [
      step('a'),
      step('b')
    ])
    // Same ids, a newer risky step: JEV's reading of the old one must not revert it.
    rewritten.store.update(set.id, (current) => ({
      ...current,
      suggestions: [{ ...step('a'), prompt: 'Force-push main.', risk: 'risky' }, step('b')]
    }))
    await settle()
    expect(rewritten.store.get(set.id)?.suggestions[0]).toMatchObject({ id: 'a', risk: 'risky' })
    expect(rewritten.store.get(set.id)?.rankedBy).toBeUndefined()

    const off = setup()
    observeNextStepTurn(off.service, conversation, 'tab:1@1', turn())
    const other = registerParsedNextSteps(off.service, conversation, 'tab:1@1', [
      step('a'),
      step('b')
    ])
    off.switchTo({ enabled: true, jev: { rank: false, risk: false, doneness: true } })
    await settle()
    expect(off.store.get(other.id)?.suggestions.map((s) => s.id)).toEqual(['a', 'b'])
    expect(off.store.get(other.id)?.rankedBy).toBeUndefined()
  })

  it('carries no doneness while the switch is off', async () => {
    const { jev, service } = setup({
      enabled: true,
      jev: { rank: true, risk: true, doneness: false }
    })
    observeNextStepTurn(service, conversation, 'tab:1@1', turn())
    jev.assessTurn(turn())
    await settle()
    expect((await currentNextSteps(service, conversation)).doneness).toBeUndefined()
  })
})
