import { expect, it } from 'vitest'
import {
  assertSessionOutcomeInferredConditions,
  sessionOutcomeQuotedInstruction
} from './session-outcome-inferred-authority'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'

const prompt = 'Write the approved summary. Then prepare the separate appendix.'
const input = (): SessionOutcomeCommit => ({
  source: 'ai',
  expectedSourcePrompt: prompt,
  expectedRevision: 0,
  outcomes: [
    {
      id: 'summary',
      title: 'Summary',
      finish: 'complete',
      dependsOn: [],
      conditions: [{ id: 'file', kind: 'file', target: '/approved/summary.txt' }],
      actions: [
        {
          id: 'write',
          instruction: 'Write the approved summary.',
          authority: 'existing-user-authority',
          agent: 'codex',
          conditionIds: ['file']
        }
      ]
    }
  ]
})
it('accepts a scoped exact source quote without duplicating the entire multi-outcome instruction', () => {
  expect(sessionOutcomeQuotedInstruction('Write the approved summary.', prompt)).toBe(true)
  expect(sessionOutcomeQuotedInstruction('Publish the approved summary.', prompt)).toBe(false)
  expect(sessionOutcomeQuotedInstruction('Write', prompt)).toBe(false)
  expect(() => assertSessionOutcomeInferredConditions(input(), undefined, prompt)).not.toThrow()
})
it('rejects stale source and newly executable verifiers on direct host admission', () => {
  expect(() =>
    assertSessionOutcomeInferredConditions(input(), undefined, 'Different source')
  ).toThrow('source prompt changed')
  const command = input()
  command.outcomes[0]!.conditions[0] = {
    id: 'file',
    kind: 'command',
    target: 'claimed proof',
    verification: { program: 'sh', args: ['-c', 'touch forbidden'] }
  }
  expect(() => assertSessionOutcomeInferredConditions(command, undefined, prompt)).toThrow(
    'user-authored'
  )
})
it('rejects a local report proxy for an external action even if the outcome title omits the destination', () => {
  const external = input()
  external.expectedSourcePrompt = 'Publish the approved summary to the destination.'
  external.outcomes[0]!.actions[0]!.instruction = external.expectedSourcePrompt
  expect(() =>
    assertSessionOutcomeInferredConditions(external, undefined, external.expectedSourcePrompt)
  ).toThrow('local result note')
})

it.each(['my-review', 'human-handoff', 'merge'] as const)(
  'refuses AI weakening %s even when IDs are retained',
  (finish) => {
    const proposed = input()
    proposed.expectedRevision = 1
    const prior = structuredClone(proposed.outcomes[0]!)
    prior.finish = finish
    prior.conditions.push({
      id: 'required',
      kind: finish === 'my-review' ? 'review' : finish === 'human-handoff' ? 'handoff' : 'merge',
      target: 'required-destination'
    })
    const old = { outcomeSet: { revision: 1, outcomes: [prior] } } as unknown as SessionChain
    expect(() => assertSessionOutcomeInferredConditions(proposed, old, prompt)).toThrow(
      'AI cannot weaken'
    )
    expect(() =>
      assertSessionOutcomeInferredConditions({ ...proposed, source: 'user' }, old)
    ).not.toThrow()
  }
)

it.each(['condition', 'dependency', 'action', 'instructions', 'step'] as const)(
  'retains existing %s authority while allowing additive obligations',
  (change) => {
    const proposed = input()
    proposed.expectedRevision = 1
    const prior = structuredClone(proposed.outcomes[0]!)
    if (change === 'dependency') {
      prior.dependsOn = ['dependency']
      proposed.outcomes.push({ ...structuredClone(prior), id: 'dependency', dependsOn: [] })
    }
    if (change === 'instructions') {
      prior.instructions = 'Keep this required scope.'
    }
    if (change === 'step') {
      prior.stepIds = ['existing-step']
    }
    if (change === 'condition') {
      proposed.outcomes[0]!.conditions[0]!.target = '/different-destination'
    }
    if (change === 'action') {
      proposed.outcomes[0]!.actions = []
    }
    const old = { outcomeSet: { revision: 1, outcomes: [prior] } } as unknown as SessionChain
    expect(() => assertSessionOutcomeInferredConditions(proposed, old, prompt)).toThrow(
      'AI cannot weaken'
    )
    const added = { ...input(), expectedRevision: 1 }
    const unchanged = structuredClone(added.outcomes[0]!)
    added.outcomes.push({ ...structuredClone(unchanged), id: 'appendix', dependsOn: ['summary'] })
    expect(() =>
      assertSessionOutcomeInferredConditions(
        added,
        { outcomeSet: { revision: 1, outcomes: [unchanged] } } as unknown as SessionChain,
        prompt
      )
    ).not.toThrow()
  }
)

it.each([
  ['merge', 'merge', 'Fix the null check in foo.ts, then merge it.'],
  ['pr', 'pr', 'Fix the null check in foo.ts and open a pull request.'],
  ['deployment', 'deploy', 'Fix the null check in foo.ts and deploy it.'],
  ['handoff', 'human-handoff', 'Fix the null check in foo.ts and send it to Sal.'],
  ['merge', 'merge', 'Resolve the merge conflict in foo.ts, do not merge yet.'],
  ['handoff', 'human-handoff', 'Ask before touching bar.ts.'],
  ['deployment', 'deploy', 'Write the release notes for foo.ts.'],
  ['pr', 'pr', 'Fix the null check in foo.ts, see PR #146 for context.']
] as const)(
  'refuses an AI-bound %s condition even when the source prompt asks for it, incidentally mentions it, or negates it; only a retained condition or the user route grants it',
  (kind, finish, asking) => {
    const unasked = 'Fix the null check in foo.ts and write the approved summary.'
    const escalated = (prompt: string): SessionOutcomeCommit => {
      const commit = input()
      commit.expectedSourcePrompt = prompt
      commit.outcomes[0]!.finish = finish
      commit.outcomes[0]!.conditions.push({
        id: 'escalated',
        kind,
        target: 'https://github.com/omnirogue/fixture',
        ...(kind === 'handoff' ? { recipientId: 'emp_sal' } : {})
      })
      commit.outcomes[0]!.actions[0]!.instruction = 'Fix the null check in foo.ts'
      return commit
    }
    expect(() =>
      assertSessionOutcomeInferredConditions(escalated(unasked), undefined, unasked)
    ).toThrow(`does not ask for a ${kind} finish`)
    // Why: an AI cannot grant itself this authority by prompt text alone, even when the prompt
    // explicitly asks for it (this used to pass); only a retained condition or the user route can.
    expect(() =>
      assertSessionOutcomeInferredConditions(escalated(asking), undefined, asking)
    ).toThrow(`does not ask for a ${kind} finish`)
    const bound = escalated(unasked)
    bound.expectedRevision = 1
    const old = {
      outcomeSet: { revision: 1, outcomes: [structuredClone(bound.outcomes[0]!)] }
    } as unknown as SessionChain
    expect(() => assertSessionOutcomeInferredConditions(bound, old, unasked)).not.toThrow()
    expect(() =>
      assertSessionOutcomeInferredConditions({ ...escalated(unasked), source: 'user' }, undefined)
    ).not.toThrow()
  }
)

it('refuses to grant a new outcome escalated authority just because a DIFFERENT prior outcome had it', () => {
  // Why: `retained` must scope by outcome id — a user-bound handoff/merge condition on outcome A
  // must never authorize an AI-added condition of the same key on a new outcome B.
  const proposed = input()
  proposed.expectedRevision = 1
  const priorA = structuredClone(proposed.outcomes[0]!)
  priorA.finish = 'human-handoff'
  priorA.conditions.push({
    id: 'handoff-a',
    kind: 'handoff',
    target: 'required-destination',
    recipientId: 'emp_sal'
  })
  const old = { outcomeSet: { revision: 1, outcomes: [priorA] } } as unknown as SessionChain
  const withNewOutcome: SessionOutcomeCommit = {
    ...proposed,
    outcomes: [
      priorA,
      {
        id: 'other',
        title: 'Other',
        finish: 'human-handoff',
        dependsOn: [],
        conditions: [
          {
            id: 'handoff-a',
            kind: 'handoff',
            target: 'required-destination',
            recipientId: 'emp_sal'
          }
        ],
        actions: []
      }
    ]
  }
  expect(() => assertSessionOutcomeInferredConditions(withNewOutcome, old, prompt)).toThrow(
    'does not ask for a handoff finish'
  )
})
