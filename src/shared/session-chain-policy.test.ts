import { describe, expect, it } from 'vitest'
import { compileNextStepChain } from './next-step-compile'
import { emptyNextStepDraft, type NextStepDraft } from './next-step-draft'
import { nextStepDraftPolicyBlockMessages } from './next-step-policy'
import { nextStepTemplateDraft } from './next-step-templates'
import { sessionChainPolicyBlocks, sessionChainPolicyProblems } from './session-chain-policy'
import type { SessionChain, SessionChainAgentStep } from './session-chain-types'

function step(
  id: string,
  agent: SessionChainAgentStep['agent'],
  extra: Partial<SessionChainAgentStep> = {}
): SessionChainAgentStep {
  return { id, agent, prompt: 'p', status: 'queued', ...extra }
}

function compile(draft: NextStepDraft) {
  return compileNextStepChain({
    draft,
    chainId: 'chn',
    workspacePath: '/w',
    sessionLabel: 's',
    defaultNote: 'n',
    now: 1,
    mintStepId: (position) => `step_${position}`,
    mintOperationId: () => 'op_0'
  })
}

describe('sessionChainPolicyProblems', () => {
  it('blocks a Gemini reviewer, whatever it reviews', () => {
    const chain = { steps: [step('a', 'claude'), step('b', 'gemini', { presetId: 'review' })] }
    const [problem] = sessionChainPolicyProblems(chain)
    expect(problem).toMatchObject({ level: 'block', code: 'gemini-verdict', stepId: 'b' })
  })

  it('blocks a reviewer that is the exact model which produced the work', () => {
    const chain = {
      steps: [
        step('a', 'claude', { model: 'opus' }),
        step('b', 'claude', { model: 'opus', presetId: 'review' })
      ]
    }
    expect(sessionChainPolicyProblems(chain)).toMatchObject([
      { level: 'block', code: 'reviewer-is-producer', stepId: 'b' }
    ])
  })

  it('only warns when the reviewer shares a family but not the exact model, or the model is unknown', () => {
    const sameFamily = {
      steps: [
        step('a', 'claude', { model: 'opus' }),
        step('b', 'claude', { model: 'sonnet', presetId: 'review' })
      ]
    }
    expect(sessionChainPolicyProblems(sameFamily)).toMatchObject([
      { level: 'warn', code: 'same-lineage' }
    ])
    const unknownModel = { steps: [step('b', 'claude', { presetId: 'review' })] }
    expect(sessionChainPolicyProblems(unknownModel, { agent: 'claude' })).toMatchObject([
      { level: 'warn', code: 'same-lineage' }
    ])
    expect(sessionChainPolicyBlocks(sessionChainPolicyProblems(unknownModel))).toEqual([])
  })

  it('reads the source session as the producer of a plan whose first step reviews', () => {
    const chain = { steps: [step('b', 'codex', { model: 'gpt', presetId: 'review' })] }
    expect(sessionChainPolicyProblems(chain, { agent: 'codex', model: 'gpt' })).toMatchObject([
      { level: 'block', code: 'reviewer-is-producer' }
    ])
    expect(sessionChainPolicyProblems(chain, { agent: 'claude', model: 'opus' })).toEqual([])
  })

  it('blocks a judge from any family among the candidates it judges', () => {
    const chain = {
      steps: [
        step('c1', 'claude', { group: 'g1' }),
        step('c2', 'codex', { group: 'g1' }),
        step('j', 'claude', { model: 'opus', presetId: 'review' })
      ]
    }
    expect(sessionChainPolicyProblems(chain)).toMatchObject([
      { level: 'block', code: 'judge-in-candidates', stepId: 'j' }
    ])
    const neutral = {
      steps: [chain.steps[0]!, chain.steps[1]!, step('j', 'grok', { presetId: 'review' })]
    }
    expect(sessionChainPolicyProblems(neutral)).toEqual([])
  })

  it('judges the repaired candidate, not the earlier reviewers, in a later round', () => {
    const chain: Pick<SessionChain, 'steps'> = {
      steps: [
        step('r1', 'claude', { model: 'opus', presetId: 'review' }),
        step('fix', 'codex', {
          model: 'gpt',
          reviewRepair: { groupId: 'g', afterRound: 1, candidateVersion: 'v1', consumptionKey: 'k' }
        }),
        step('r2', 'codex', { model: 'gpt', presetId: 'review' })
      ]
    }
    expect(sessionChainPolicyProblems(chain, { agent: 'grok' })).toMatchObject([
      { level: 'block', code: 'reviewer-is-producer', stepId: 'r2' }
    ])
  })

  it('leaves the existing templates unblocked and the Best-of-N judge neutral', () => {
    const agents = ['claude', 'codex', 'grok'] as const
    let keys = 0
    const input = { agents, mintKey: () => `k${(keys += 1)}` }
    for (const id of ['council', 'compare-answers', 'best-of-n'] as const) {
      const draft = nextStepTemplateDraft(id, input)!
      const { steps, problems } = compile(draft)
      expect(problems).toEqual([])
      expect(
        sessionChainPolicyBlocks(sessionChainPolicyProblems({ steps }, { agent: 'kimi' }))
      ).toEqual([])
    }
    const plain = emptyNextStepDraft()
    expect(sessionChainPolicyProblems({ steps: compile(plain).steps })).toEqual([])
  })
})

describe('nextStepDraftPolicyBlockMessages', () => {
  it('returns the review blocks of an outcome plan as plain messages', () => {
    const draft: NextStepDraft = {
      ...emptyNextStepDraft(),
      outcomes: [
        {
          id: 'o1',
          finish: { kind: 'complete' },
          instructions: 'ship it',
          steps: [
            {
              id: 'r',
              kind: 'review',
              reviewers: [{ agent: 'gemini' }],
              maxRounds: 1,
              instructions: '',
              adversarial: false
            }
          ]
        }
      ]
    }
    const problems = nextStepDraftPolicyBlockMessages(draft, 'claude', 'opus')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('Gemini never issues a review verdict')
    expect(nextStepDraftPolicyBlockMessages({ ...draft, outcomes: [] }, null, null)).toEqual([])
  })
})

/** WP-1: the reversal — honouring `readsFrom` CREATES judge blocks, so the actor must be assigned. */
describe('sessionChainPolicyProblems with work-plan edges', () => {
  type PlanStep = Partial<SessionChainAgentStep> & {
    readsFrom?: string[]
    verdict?: { kind: string; over: string[]; consumed: string }
  }

  function planStep(
    id: string,
    agent: SessionChainAgentStep['agent'],
    extra: PlanStep = {}
  ): SessionChainAgentStep {
    return { id, agent, prompt: 'p', status: 'queued', ...extra } as SessionChainAgentStep
  }

  it('recognises every verdict role, so a judge can no longer slip past the policy', () => {
    for (const presetId of ['review', 'verify', 'judge', 'critique', 'compare'] as const) {
      const chain = { steps: [planStep('a', 'claude'), planStep('b', 'gemini', { presetId })] }
      expect(sessionChainPolicyProblems(chain)).toMatchObject([{ code: 'gemini-verdict' }])
    }
    // A step that decides nothing is still nobody's business.
    expect(
      sessionChainPolicyProblems({
        steps: [planStep('a', 'claude'), planStep('b', 'gemini', { presetId: 'implement' })]
      })
    ).toEqual([])
  })

  it('refuses a reviewer whose family this build cannot place, and takes the model first', () => {
    const unplaceable = {
      steps: [
        planStep('a', 'claude', { model: 'opus' }),
        planStep('r', 'opencode', { presetId: 'review' })
      ]
    }
    expect(sessionChainPolicyProblems(unplaceable)).toMatchObject([
      { level: 'block', code: 'unknown-lineage', stepId: 'r' }
    ])
    // The same CLI running a model this build knows is placed by that model, not by its name.
    const placed = {
      steps: [
        planStep('a', 'claude', { model: 'opus' }),
        planStep('r', 'opencode', { model: 'gpt-5-codex', presetId: 'review' })
      ]
    }
    expect(sessionChainPolicyProblems(placed)).toEqual([])
  })

  it('recognises a verdict carried on the step itself, before any preset is read', () => {
    const chain = {
      steps: [
        planStep('a', 'claude'),
        planStep('b', 'gemini', { verdict: { kind: 'judge', over: ['a'], consumed: 'record' } })
      ]
    }
    expect(sessionChainPolicyProblems(chain)).toMatchObject([{ code: 'gemini-verdict' }])
  })

  it('changes no verdict for anything on disk today, because nothing on disk reads explicitly', () => {
    // Three same-group reviewers: sessionChainPredecessors skips own-group siblings, so each sees
    // the source and gets a warning at most. Unchanged by the readsFrom branch.
    const chain = {
      steps: [
        planStep('r1', 'claude', { presetId: 'review', group: 'g1' }),
        planStep('r2', 'claude', { presetId: 'review', group: 'g1' }),
        planStep('r3', 'codex', { presetId: 'review', group: 'g1' })
      ]
    }
    expect(sessionChainPolicyProblems(chain, { agent: 'claude', model: 'opus' })).toMatchObject([
      { level: 'warn', code: 'same-lineage', stepId: 'r1' },
      { level: 'warn', code: 'same-lineage', stepId: 'r2' }
    ])
  })

  it('judges exactly what a step says it reads', () => {
    const steps = [
      planStep('c1', 'claude', { model: 'opus' }),
      planStep('c2', 'codex', { model: 'gpt' }),
      planStep('j', 'claude', {
        model: 'sonnet',
        presetId: 'judge',
        readsFrom: ['c2']
      })
    ]
    // Reading only the Codex candidate leaves the Claude judge neutral for that candidate...
    expect(sessionChainPolicyProblems({ steps })).toEqual([])
    // ...and naming the Claude candidate blocks it.
    expect(
      sessionChainPolicyProblems({
        steps: [
          steps[0]!,
          steps[1]!,
          planStep('j', 'claude', { presetId: 'judge', readsFrom: ['c1', 'c2'] })
        ]
      })
    ).toMatchObject([{ level: 'block', code: 'judge-in-candidates', stepId: 'j' }])
  })

  it('cannot be bypassed by reading the critiques instead of the work', () => {
    const steps = [
      planStep('a1', 'claude', { model: 'opus' }),
      planStep('a2', 'codex', { model: 'gpt' }),
      planStep('k1', 'grok', {
        presetId: 'critique',
        readsFrom: ['a1', 'a2'],
        verdict: { kind: 'critique', over: ['a1', 'a2'], consumed: 'record' }
      }),
      planStep('j', 'claude', {
        model: 'sonnet',
        presetId: 'judge',
        readsFrom: ['k1'],
        verdict: { kind: 'judge', over: ['a1', 'a2'], consumed: 'select-winner' }
      })
    ]
    expect(sessionChainPolicyProblems({ steps })).toMatchObject([
      { level: 'block', code: 'judge-in-candidates', stepId: 'j' }
    ])
  })

  it('blocks a judge that shares a family with its only candidate, which a reviewer may warn about', () => {
    const judged = {
      steps: [
        planStep('a', 'claude', { model: 'opus' }),
        planStep('j', 'claude', { model: 'sonnet', presetId: 'judge' })
      ]
    }
    expect(sessionChainPolicyProblems(judged)).toMatchObject([
      { level: 'block', code: 'judge-in-candidates', stepId: 'j' }
    ])
    const reviewed = {
      steps: [
        planStep('a', 'claude', { model: 'opus' }),
        planStep('r', 'claude', { model: 'sonnet', presetId: 'review' })
      ]
    }
    expect(sessionChainPolicyProblems(reviewed)).toMatchObject([{ level: 'warn' }])
  })

  it("passes Sal's assigned actors and a council that reads the OTHER answers", () => {
    const sal = {
      steps: [
        planStep('p1', 'claude', { model: 'opus', group: 'plan', presetId: 'plan' }),
        planStep('p2', 'codex', { model: 'gpt', group: 'plan', presetId: 'plan' }),
        planStep('p3', 'grok', { model: 'grok-4', group: 'plan', presetId: 'plan' }),
        planStep('j', 'kimi', {
          model: 'k2',
          presetId: 'judge',
          readsFrom: ['p1', 'p2', 'p3'],
          verdict: { kind: 'judge', over: ['p1', 'p2', 'p3'], consumed: 'select-winner' }
        })
      ]
    }
    expect(sessionChainPolicyProblems(sal, { agent: 'claude', model: 'opus' })).toEqual([])
    const answers = [
      planStep('a1', 'claude', { model: 'opus', group: 'answers' }),
      planStep('a2', 'codex', { model: 'gpt', group: 'answers' }),
      planStep('a3', 'grok', { model: 'grok-4', group: 'answers' })
    ]
    const council = {
      steps: [
        ...answers,
        planStep('k1', 'claude', {
          model: 'opus',
          presetId: 'critique',
          group: 'critiques',
          readsFrom: ['a2', 'a3']
        }),
        planStep('k2', 'codex', {
          model: 'gpt',
          presetId: 'critique',
          group: 'critiques',
          readsFrom: ['a1', 'a3']
        }),
        planStep('k3', 'grok', {
          model: 'grok-4',
          presetId: 'critique',
          group: 'critiques',
          readsFrom: ['a1', 'a2']
        })
      ]
    }
    expect(sessionChainPolicyProblems(council, { agent: 'claude', model: 'opus' })).toEqual([])
    // Reading its own answer too is exactly the collision the reversal is meant to catch.
    const selfReading = {
      steps: [
        ...answers,
        planStep('k1', 'claude', {
          model: 'opus',
          presetId: 'critique',
          group: 'critiques',
          readsFrom: ['a1', 'a2', 'a3']
        })
      ]
    }
    expect(sessionChainPolicyBlocks(sessionChainPolicyProblems(selfReading))).toMatchObject([
      { code: 'judge-in-candidates', stepId: 'k1' }
    ])
  })
})
