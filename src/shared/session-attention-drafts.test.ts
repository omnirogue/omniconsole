import { describe, expect, it } from 'vitest'
import {
  agentPromptAttention,
  attemptRequirementAttention,
  ownReviewAttention,
  personReviewAttention,
  principalAttention,
  reviewFindingsAttention,
  verificationGateAttention
} from './session-attention-drafts'
import {
  humanAttentionId,
  humanAttentionRequestSchema,
  openHumanAttention,
  type HumanAttentionDraft,
  type HumanAttentionRequest
} from './session-human-attention'

const scope = { outcomeId: 'one', outcomeRevision: 1 }
const reviewScope = { ...scope, conditionId: 'my_review' }
const host: {
  attention?: HumanAttentionRequest[]
  outcomes: { id: string; revision: number; status: string }[]
  attempts: { id: string; state: string }[]
} = {
  outcomes: [{ id: 'one', revision: 1, status: 'blocked' }],
  attempts: [{ id: 'att_1', state: 'blocked' }]
}

/** Every draft must survive the strict schema: a request the set cannot hold costs the whole plan. */
function opened(draft: HumanAttentionDraft) {
  const result = openHumanAttention(host, draft, 100)
  expect(result.opened).toBe(true)
  return humanAttentionRequestSchema.parse(result.set.attention![0])
}

describe('the words of a request', () => {
  it("states an agent's question and a permission prompt as the owner's to answer", () => {
    const question = opened(
      agentPromptAttention({
        scope: { ...scope, attemptId: 'att_1' },
        kind: 'clarification',
        agent: 'Codex',
        prompt: 'Which   branch\nshould I target?',
        paneKey: 'tab-2:leaf-1'
      })
    )
    expect(question).toMatchObject({
      kind: 'clarification',
      recipient: { type: 'owner' },
      ask: "Answer Codex's question: Which branch should I target?",
      action: { kind: 'open-conversation', label: 'Answer', paneKey: 'tab-2:leaf-1' },
      source: { type: 'agent-prompt', ref: 'Which branch should I target?' }
    })
    const permission = opened(
      agentPromptAttention({
        scope: { ...scope, attemptId: 'att_1' },
        kind: 'permission',
        agent: 'Codex',
        prompt: 'Run rm -rf build?'
      })
    )
    expect(permission).toMatchObject({
      kind: 'permission',
      ask: 'Allow or deny what Codex is asking to do: Run rm -rf build?',
      why: 'Codex stopped at a permission prompt that only you may answer.',
      action: { kind: 'open-conversation', label: 'Review request' }
    })
    expect(permission.action?.paneKey).toBeUndefined()
  })

  it('clips a prompt to what the schema holds, and never produces an empty source', () => {
    const long = agentPromptAttention({
      scope,
      kind: 'clarification',
      agent: 'Codex',
      prompt: 'word '.repeat(2_000)
    })
    expect(long.ask.length).toBeLessThanOrEqual(2_000)
    expect(long.ask.endsWith('…')).toBe(true)
    expect(long.source.ref.length).toBeLessThanOrEqual(400)
    expect(opened(long).state).toBe('open')
    const blank = agentPromptAttention({ scope, kind: 'permission', agent: 'Codex', prompt: ' ' })
    expect(blank.source.ref).toBe('permission')
    expect(opened(blank).state).toBe('open')
    expect(opened(verificationGateAttention({ scope, summary: '  ' })).source.ref).toBe(
      'verification'
    )
    // A pane key the schema cannot hold is left out rather than refusing the request.
    const pane = agentPromptAttention({
      scope,
      kind: 'clarification',
      agent: 'Codex',
      prompt: 'Which one?',
      paneKey: 'p'.repeat(201)
    })
    expect(pane.action).toEqual({ kind: 'open-conversation', label: 'Answer' })
  })

  it("addresses the owner's own review to the owner, with the condition to review", () => {
    const request = opened(
      ownReviewAttention({ scope: reviewScope, title: 'The report', version: 'v3' })
    )
    expect(request).toMatchObject({
      kind: 'review',
      recipient: { type: 'owner' },
      ask: 'Review the result of "The report" and approve it or send it back.',
      action: { kind: 'review-outcome', label: 'Review', conditionId: 'my_review' },
      source: { type: 'review-condition', ref: 'v3' }
    })
    // Each reviewed version is its own requirement; without one, the condition is.
    expect(
      humanAttentionId(ownReviewAttention({ scope: reviewScope, title: 'The report' }))
    ).not.toBe(request.id)
    expect(ownReviewAttention({ scope: reviewScope, title: 'The report' }).source.ref).toBe(
      'my_review'
    )
  })

  it("addresses another person's review to that person, never to the owner", () => {
    const request = opened(
      personReviewAttention({
        scope: reviewScope,
        title: 'The report',
        employeeId: 'emp_gamma',
        name: 'Gamma'
      })
    )
    expect(request.recipient).toEqual({ type: 'person', employeeId: 'emp_gamma', name: 'Gamma' })
    expect(request.action).toBeUndefined()
    expect(request.source).toEqual({ type: 'review-condition', ref: 'emp_gamma:my_review' })
    const unnamed = personReviewAttention({
      scope: reviewScope,
      title: 'The report',
      employeeId: 'emp_gamma'
    })
    expect(unnamed.recipient).toEqual({ type: 'person', employeeId: 'emp_gamma' })
    // The same condition asked of the owner and of a person are two requirements.
    expect(humanAttentionId(unnamed)).not.toBe(
      humanAttentionId(ownReviewAttention({ scope: reviewScope, title: 'The report' }))
    )
  })

  it('asks for a decision after the authorized review rounds, a failed gate, and a lost principal', () => {
    expect(opened(reviewFindingsAttention({ scope, rounds: 2, findings: 3 }))).toMatchObject({
      kind: 'decision',
      recipient: { type: 'owner' },
      ask: 'Decide what happens to 3 open review findings: add another repair stage, or finish with the work as it is.',
      why: 'All 2 authorized review rounds are used; another one needs your say.',
      action: { kind: 'open-up-next', label: 'Decide' },
      source: { type: 'review-findings', ref: 'rounds:2' }
    })
    const single = reviewFindingsAttention({ scope, rounds: 1, findings: 1 })
    expect(single.ask).toContain('1 open review finding:')
    expect(single.why).toBe('The one authorized review round is used; another one needs your say.')
    expect(
      opened(verificationGateAttention({ scope, summary: 'pnpm test exited 1' }))
    ).toMatchObject({
      kind: 'decision',
      action: { kind: 'open-up-next', label: 'Decide' },
      source: { type: 'verification-gate', ref: 'pnpm test exited 1' }
    })
    expect(opened(principalAttention(scope))).toMatchObject({
      kind: 'credential',
      action: { kind: 'sign-in', label: 'Sign in' },
      source: { type: 'principal', ref: 'one' }
    })
  })
})

describe('the requirements the recovery ladder can find', () => {
  const stepScope = { ...scope, attemptId: 'att_1', stepId: 's1' }
  const requirement = (
    name: Parameters<typeof attemptRequirementAttention>[0]['requirement'],
    extra: { detail?: string; paneKey?: string } = {}
  ) =>
    opened(
      attemptRequirementAttention({ requirement: name, scope: stepScope, agent: 'Codex', ...extra })
    )

  it('asks for a sign-in where the agent runs', () => {
    expect(requirement('provider-authentication', { paneKey: 'tab-2:leaf-1' })).toMatchObject({
      kind: 'credential',
      recipient: { type: 'owner' },
      ask: 'Sign Codex in again.',
      action: { kind: 'open-conversation', label: 'Sign in', paneKey: 'tab-2:leaf-1' },
      source: { type: 'provider-authentication', ref: 'Codex' }
    })
  })

  it('asks for usage, an approval, or a shorter stage, each with its own way in', () => {
    expect(requirement('provider-usage-limit')).toMatchObject({
      kind: 'credential',
      action: { kind: 'open-up-next', label: 'Choose account' },
      source: { type: 'provider-usage-limit', ref: 'Codex' }
    })
    expect(requirement('provider-approval', { detail: 'codex-hooks-review-prompt' })).toMatchObject(
      {
        kind: 'approval',
        ask: "Answer Codex's startup prompt (codex-hooks-review-prompt) in its conversation.",
        action: { kind: 'open-conversation', label: 'Open prompt' },
        source: { type: 'provider-approval', ref: 'Codex:codex-hooks-review-prompt' }
      }
    )
    expect(requirement('provider-approval').source.ref).toBe('Codex:startup')
    expect(requirement('brief-too-large')).toMatchObject({
      kind: 'clarification',
      action: { kind: 'open-up-next', label: 'Edit stage' },
      source: { type: 'brief-too-large', ref: 's1' }
    })
  })
})
