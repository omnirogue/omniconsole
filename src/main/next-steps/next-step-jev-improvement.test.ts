import { describe, expect, it, vi } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import type { NextStepSuggestionSettings } from '../../shared/next-step-suggestion-settings'
import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import type { JevRankOptions } from '../structured-decisions/jev-rank'
import { NextStepJev } from './next-step-jev'
import { NextStepDonenessCache } from './next-step-jev-doneness'
import { judgeNextStepImprovement } from './next-step-jev-improvement'

const conversation: ConversationSource = { worktreeId: 'repo::/w', paneKey: 'tab:1', kind: 'pty' }

/** JEV answering by which version is shown as A (`latestFirst`) or B. */
function jev(latestSecond: number, latestFirst: number) {
  const evaluate = vi.fn(async (request: DecisionRequest): Promise<DecisionResult> => {
    const state = request.state as Record<string, string>
    const shownFirst = state.version_a === 'NEW'
    return {
      provider: 'typesafe',
      model: 'jev-1.13.0',
      usage: { inputTokens: 1, outputTokens: 1 },
      answers: {
        latest_better: { type: 'noul', noul: shownFirst ? latestFirst : latestSecond }
      }
    }
  })
  return {
    evaluate,
    options: { evaluate, credential: async () => 'k'.repeat(24), environment: {} }
  }
}

const input = {
  goal: 'Write the ad',
  pushPrompt: 'Make it better.',
  previous: 'OLD',
  latest: 'NEW'
}

describe('judgeNextStepImprovement', () => {
  it('asks both orders and averages them', async () => {
    const mock = jev(0.9, 0.86)
    const verdict = await judgeNextStepImprovement(input, mock.options)
    expect(verdict?.unsure).toBe(false)
    expect(verdict?.improved).toBeCloseTo(0.88)
    expect(mock.evaluate).toHaveBeenCalledTimes(2)
    const shown = mock.evaluate.mock.calls.map(
      ([r]) => (r.state as Record<string, string>).version_b
    )
    expect(shown.toSorted()).toEqual(['NEW', 'OLD'])
  })

  it('is unsure unless each order is clear on its own and both agree', async () => {
    const unsure = async (second: number, first: number) =>
      (await judgeNextStepImprovement(input, jev(second, first).options))?.unsure
    expect(await unsure(0.5, 0.45)).toBe(true)
    // The order flips the answer.
    expect(await unsure(0.95, 0.02)).toBe(true)
    // Averaging must not turn one unsure order into a verdict, nor rounding pull 0.201 out.
    expect(await unsure(0.1, 0.3)).toBe(true)
    expect(await unsure(0.201, 0.201)).toBe(true)
    expect(await unsure(0.05, 0.08)).toBe(false)
    expect(await unsure(0.85, 0.9)).toBe(false)
  })

  it('is null when JEV cannot answer or a version is missing', async () => {
    const mock = jev(0.9, 0.9)
    const keyless = { ...mock.options, credential: async () => undefined }
    expect(await judgeNextStepImprovement(input, keyless)).toBeNull()
    expect(await judgeNextStepImprovement({ ...input, previous: ' ' }, mock.options)).toBeNull()
    expect(mock.evaluate).not.toHaveBeenCalled()
  })
})

describe('NextStepJev.keepGoingJudges', () => {
  const judges = (
    settings: NextStepSuggestionSettings,
    options: JevRankOptions = jev(0.1, 0.1).options,
    goal: string | null = 'Write the ad'
  ) => {
    const host = new NextStepJev({
      settings: () => settings,
      cache: new NextStepDonenessCache(),
      jev: options
    })
    if (goal) {
      host.noteTurn({ conversation, turnKey: 't0', lastAssistantMessage: '', lastUserPrompt: goal })
    }
    return host.keepGoingJudges()
  }
  const round = { conversation, turnKey: 't', previous: 'OLD', latest: 'NEW', pushPrompt: 'p' }

  it('reads nothing while the doneness switch is off', async () => {
    const mock = jev(0.1, 0.1)
    const off = judges(
      { enabled: true, jev: { rank: true, risk: true, doneness: false } },
      mock.options
    )
    expect(await off.assessDoneness({ conversation, turnKey: 't', reply: 'r' })).toBeNull()
    expect(
      await off.judgeImprovement({
        conversation,
        turnKey: 't',
        previous: 'OLD',
        latest: 'NEW',
        pushPrompt: 'p'
      })
    ).toBeNull()
    expect(mock.evaluate).not.toHaveBeenCalled()
  })

  it('is null without JEV, so Keep going keeps only its cap', async () => {
    const keyless = { ...jev(0.1, 0.1).options, credential: async () => undefined }
    const on = judges({ enabled: true }, keyless)
    expect(
      await on.judgeImprovement({
        conversation,
        turnKey: 't',
        previous: 'OLD',
        latest: 'NEW',
        pushPrompt: 'p'
      })
    ).toBeNull()
    // Nor a doneness reading.
    expect(await on.assessDoneness({ conversation, turnKey: 't', reply: 'r' })).toBeNull()
  })

  it('sends nothing when the switch goes off while the goal is being read', async () => {
    const mock = jev(0.05, 0.1)
    let settings: NextStepSuggestionSettings = { enabled: true }
    let answerCard = (): void => {}
    const host = new NextStepJev({
      settings: () => settings,
      cache: new NextStepDonenessCache(),
      jev: mock.options,
      // The linked card cannot be read, so the goal falls back to the first prompt.
      readTaskCard: () =>
        new Promise((resolve) => {
          answerCard = () => resolve({ ok: false, error: 'unavailable' } as never)
        })
    })
    host.noteTurn({ conversation, turnKey: 't0', lastAssistantMessage: '', lastUserPrompt: 'Ad' })
    host.linkTask(conversation, 'btk_1')
    const judging = host.keepGoingJudges().judgeImprovement(round)
    settings = { enabled: true, jev: { rank: true, risk: true, doneness: false } }
    answerCard()
    expect(await judging).toBeNull()
    expect(mock.evaluate).not.toHaveBeenCalled()
  })

  it('gives no verdict without a goal to judge "better" against', async () => {
    const mock = jev(0.05, 0.1)
    expect(await judges({ enabled: true }, mock.options, null).judgeImprovement(round)).toBeNull()
    expect(mock.evaluate).not.toHaveBeenCalled()
  })

  it('judges a round with the conversation goal', async () => {
    const mock = jev(0.05, 0.1)
    const verdict = await judges({ enabled: true }, mock.options).judgeImprovement({
      conversation,
      turnKey: 't',
      previous: 'OLD',
      latest: 'NEW',
      pushPrompt: 'p'
    })
    expect(verdict?.unsure).toBe(false)
    expect(verdict?.improved).toBeCloseTo(0.075)
  })
})
