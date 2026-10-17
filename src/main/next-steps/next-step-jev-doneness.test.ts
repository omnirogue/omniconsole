import { describe, expect, it, vi } from 'vitest'
import type { ConsoleTaskCard, ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import type { ConversationSource } from '../../shared/conversation-source'
import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import { assessNextStepDoneness, NextStepDonenessCache } from './next-step-jev-doneness'
import { resolveNextStepGoal } from './next-step-jev-goal'

const conversation: ConversationSource = { worktreeId: 'repo::/w', paneKey: 'tab:1', kind: 'pty' }

function jev(readings: Record<string, number>) {
  const evaluate = vi.fn(async (_request: DecisionRequest): Promise<DecisionResult> => ({
    provider: 'typesafe',
    model: 'jev-1.13.0',
    usage: { inputTokens: 1, outputTokens: 1 },
    answers: Object.fromEntries(
      Object.entries(readings).map(([id, noul]) => [id, { type: 'noul' as const, noul }])
    )
  }))
  return {
    evaluate,
    options: {
      evaluate,
      credential: async () => 'k'.repeat(24),
      environment: {},
      cache: new NextStepDonenessCache(),
      now: () => 42
    }
  }
}

const input = (turnKey = 'tab:1@1', goal = 'Fix the parser') => ({
  conversation,
  turnKey,
  goal,
  replyTail: 'I fixed the parser and ran pnpm test: 12 passed.'
})

describe('assessNextStepDoneness', () => {
  it('maps the four readings and asks all of them in one call', async () => {
    const mock = jev({ resolved: 0.95, remaining_work: 0.05, room_to_improve: 0.1, verified: 0.9 })
    const reading = await assessNextStepDoneness(input(), mock.options)
    expect(reading).toEqual({
      resolved: 0.95,
      remainingWork: 0.05,
      roomToImprove: 0.1,
      verified: 0.9,
      unsure: false,
      turnKey: 'tab:1@1',
      at: 42
    })
    const request = mock.evaluate.mock.calls[0]![0]
    expect(Object.keys(request.questions)).toEqual([
      'resolved',
      'remaining_work',
      'room_to_improve',
      'verified'
    ])
    expect(request.state).toMatchObject({ goal: 'Fix the parser' })
  })

  it('is unsure when any reading sits inside (0.2, 0.8)', async () => {
    const mock = jev({ resolved: 0.95, remaining_work: 0.1, room_to_improve: 0.5, verified: 0.9 })
    expect((await assessNextStepDoneness(input(), mock.options))?.unsure).toBe(true)
    const edge = jev({ resolved: 0.8, remaining_work: 0.2, room_to_improve: 0.2, verified: 0.8 })
    expect((await assessNextStepDoneness(input(), edge.options))?.unsure).toBe(false)
  })

  it('asks once per turn: cached, and a concurrent caller joins the call in flight', async () => {
    const mock = jev({ resolved: 0.9, remaining_work: 0.05, room_to_improve: 0.1, verified: 0.9 })
    const [first, second] = await Promise.all([
      assessNextStepDoneness(input(), mock.options),
      assessNextStepDoneness(input(), mock.options)
    ])
    const third = await assessNextStepDoneness(input(), mock.options)
    expect(first).toBe(second)
    expect(third).toBe(first)
    expect(mock.evaluate).toHaveBeenCalledTimes(1)
    await assessNextStepDoneness(input('tab:1@2'), mock.options)
    expect(mock.evaluate).toHaveBeenCalledTimes(2)
  })

  it('is null when JEV is off, keyless, failing, incomplete, or there is no goal', async () => {
    const mock = jev({ resolved: 0.9, remaining_work: 0.05, room_to_improve: 0.1, verified: 0.9 })
    const off = { ...mock.options, environment: { JEV_DECISIONS_DISABLED: 'true' } }
    expect(await assessNextStepDoneness(input(), off)).toBeNull()
    const keyless = { ...mock.options, credential: async () => undefined }
    expect(await assessNextStepDoneness(input(), keyless)).toBeNull()
    expect(await assessNextStepDoneness(input('t@9', '  '), mock.options)).toBeNull()
    expect(mock.evaluate).not.toHaveBeenCalled()
    const failing = {
      ...mock.options,
      evaluate: vi.fn(async () => {
        throw new Error('timeout')
      })
    }
    expect(await assessNextStepDoneness(input('t@3'), failing)).toBeNull()
    const partial = jev({ resolved: 0.9 })
    expect(await assessNextStepDoneness(input('t@4'), partial.options)).toBeNull()
    // A failure is not cached: the next caller may ask again.
    expect(await assessNextStepDoneness(input('t@3'), mock.options)).not.toBeNull()
  })
})

const EMPTY_CARD: ConsoleTaskCard = {
  id: 'btk_1',
  title: '',
  status: null,
  ownerEmployeeId: null,
  companySlug: null,
  nextAction: null,
  description: null,
  dueDate: null,
  updatedAt: null,
  blocked: false
}

describe('resolveNextStepGoal', () => {
  const card = (title: string, nextAction: string | null = null) =>
    vi.fn(async (): Promise<ConsoleWorkflowResult<ConsoleTaskCard>> => ({
      ok: true,
      data: { ...EMPTY_CARD, title, nextAction }
    }))

  it('prefers the linked card, then the first prompt, then the latest', async () => {
    const readTaskCard = card('Ship the parser fix', 'Run the tests')
    expect(
      await resolveNextStepGoal({
        taskId: 'btk_1',
        readTaskCard,
        firstPrompt: 'first',
        latestPrompt: 'latest'
      })
    ).toBe('Ship the parser fix\nNext action: Run the tests')
    expect(readTaskCard).toHaveBeenCalledWith({ taskId: 'btk_1' })
    expect(await resolveNextStepGoal({ firstPrompt: 'first', latestPrompt: 'latest' })).toBe(
      'first'
    )
    expect(await resolveNextStepGoal({ latestPrompt: 'latest' })).toBe('latest')
    expect(await resolveNextStepGoal({})).toBeNull()
  })

  it('falls back to the prompts when the card cannot be read', async () => {
    const readTaskCard = vi.fn(async () => ({ ok: false as const, error: 'hub 502' }))
    expect(
      await resolveNextStepGoal({
        taskId: 'btk_1',
        readTaskCard: readTaskCard as never,
        firstPrompt: 'first'
      })
    ).toBe('first')
  })
})
