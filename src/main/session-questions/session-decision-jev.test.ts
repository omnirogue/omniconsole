import { describe, expect, it } from 'vitest'
import type { SessionDecisionRecord } from '../../shared/session-decisions'
import type { DecisionResult } from '../../shared/structured-decisions'
import {
  SESSION_DECISION_JEV_QUESTIONS,
  buildSessionDecisionJevRequest,
  createSessionDecisionScorer,
  decisionScoresFrom,
  maskDecisionText
} from './session-decision-jev'

const record: SessionDecisionRecord = {
  key: 'claude-1:toolu_1',
  paneKey: 'tab-1:leaf',
  worktreeId: 'wt-1',
  agent: 'claude',
  askedAt: 1,
  toolUseId: 'toolu_1',
  toolName: 'AskUserQuestion',
  interactivePrompt: JSON.stringify({
    questions: [
      {
        header: 'Next',
        question: 'Deploy omni-console main?',
        multiSelect: true,
        options: [
          {
            label: 'Deploy (Recommended)',
            description: 'Release 9 merged PRs to the live console'
          },
          { label: 'Wait' }
        ]
      }
    ]
  }),
  context: 'Refund for jin@example.com on card 4242 4242 4242 4242 is done.',
  providerSession: null,
  endedAt: null,
  scores: null,
  scoreFailure: null,
  updatedAt: 1
}

function scored(levels: Record<string, number>): DecisionResult {
  return {
    provider: 'typesafe',
    model: 'jev-1.13.0',
    usage: { inputTokens: 10, outputTokens: 0 },
    answers: Object.fromEntries(
      Object.entries(levels).map(([key, score]) => [
        key,
        { type: 'score', score, legend: {}, probabilities: {}, confidence: 0.9 }
      ])
    )
  }
}

describe('decision_triage for a terminal question', () => {
  it('asks the three rubric questions about the question, its options and the words before it', () => {
    const request = buildSessionDecisionJevRequest(record, 'omni-console cleanup')
    expect(request.capability).toBe('decisions.triage')
    expect(Object.keys(request.questions)).toEqual(['impact', 'risk', 'effort'])
    const state = JSON.stringify(request.state)
    expect(state).toContain('Deploy omni-console main?')
    expect(state).toContain('Deploy (Recommended) — Release 9 merged PRs to the live console')
    expect(state).toContain('[several may be chosen]')
    expect(state).toContain('omni-console cleanup')
  })

  it('never sends an email address or a card-like number', () => {
    const state = JSON.stringify(buildSessionDecisionJevRequest(record, null).state)
    expect(state).not.toContain('jin@example.com')
    expect(state).not.toContain('4242 4242')
    expect(maskDecisionText('call +1 (415) 555-0100 or a@b.co')).toBe('call [number] or [email]')
  })

  it('reports each 0–4 level as a 0–1 reading, and nothing when an answer is missing', () => {
    expect(decisionScoresFrom(scored({ impact: 3, risk: 1, effort: 0.5 }), 7)).toEqual({
      impact: 0.75,
      risk: 0.25,
      effort: 0.13,
      model: 'jev-1.13.0',
      at: 7
    })
    expect(decisionScoresFrom(scored({ impact: 3, risk: 1 }), 7)).toBeNull()
    expect(SESSION_DECISION_JEV_QUESTIONS.risk.criteria).toHaveLength(5)
  })

  it('turns a JEV refusal into a reason, never a score', async () => {
    const off = createSessionDecisionScorer({ environment: { JEV_DECISIONS_DISABLED: '1' } })
    await expect(off(record, null)).resolves.toEqual({
      failed: 'JEV is turned off on this computer'
    })
    const answered = createSessionDecisionScorer(
      {
        environment: {},
        credential: async () => 'key',
        evaluate: async () => scored({ impact: 4, risk: 4, effort: 2 })
      },
      () => 9
    )
    await expect(answered(record, null)).resolves.toMatchObject({
      impact: 1,
      risk: 1,
      effort: 0.5,
      at: 9
    })
  })
})
