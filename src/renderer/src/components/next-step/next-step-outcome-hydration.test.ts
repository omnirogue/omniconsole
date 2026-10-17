import { describe, expect, it } from 'vitest'
import type { SessionChain } from '../../../../shared/session-chain-types'
import type { SessionOutcomeDefinition } from '../../../../shared/session-outcome-types'
import { reviseSessionOutcomeSet } from '../../../../shared/session-outcome-state'
import { compileNextStepOutcomes } from '../../../../shared/next-outcome-definition-compile'
import { draftFromChain, draftWithOutcomeHandoffContext } from './next-step-outcome-hydration'
import { nextPersonChoice, outcomeReviewStep } from './next-step-outcome-sections'

function saved(outcomes: SessionOutcomeDefinition[], source: 'user' | 'ai' = 'user'): SessionChain {
  return {
    id: 'chain_edit',
    workspacePath: '/work',
    worktreeId: 'folder:/work',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    hostId: 'local',
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    outcomeSet: reviseSessionOutcomeSet(
      undefined,
      { source, expectedRevision: 0, outcomes },
      { owner: 'execution-host', hostId: 'local', epoch: 'one', state: 'owned' },
      1
    )
  }
}
const report: SessionOutcomeDefinition = {
  id: 'report',
  title: 'Write exact report',
  finish: 'complete',
  instructions: 'Write the report to ./approved/report.md.',
  dependsOn: [],
  stepIds: [],
  conditions: [{ id: 'file', kind: 'file', target: './approved/report.md' }],
  actions: [
    {
      id: 'write',
      instruction: 'Write the report to ./approved/report.md.',
      conditionIds: ['file'],
      authority: 'existing-user-authority',
      agent: 'codex'
    }
  ]
}

describe('saved outcome editing', () => {
  it('round-trips exact AI destinations, action identities and dependencies without inventing new work', () => {
    const dependent = {
      ...report,
      id: 'appendix',
      title: 'Appendix',
      instructions: undefined,
      dependsOn: ['report'],
      conditions: [{ id: 'appendix_file', kind: 'file' as const, target: '/other/appendix.md' }],
      actions: []
    }
    const chain = saved([report, dependent])
    const draft = draftFromChain(chain)
    const compiled = compileNextStepOutcomes(structuredClone(draft.outcomes!), {
      chainId: chain.id,
      workspacePath: chain.workspacePath,
      sessionLabel: 'Task',
      fallbackActor: { agent: 'codex' },
      steps: [],
      committed: { definitions: chain.outcomeSet!.outcomes, drafts: draft.outcomes! }
    })
    expect(compiled).toEqual([report, dependent])
  })
  it('restores the merge base separately from the working branch and deployment URL', () => {
    const chain = saved([
      {
        ...report,
        id: 'release',
        finish: 'deploy',
        instructions: undefined,
        conditions: [
          {
            id: 'merge',
            kind: 'merge',
            target: 'omnirogue/example',
            repository: 'omnirogue/example',
            branch: 'feature/report',
            targetBranch: 'main'
          },
          { id: 'deployment', kind: 'deployment', target: 'https://preview.example/release' }
        ],
        actions: []
      }
    ])
    expect(draftFromChain(chain).outcomes![0]!.finish).toEqual({
      kind: 'github',
      action: 'merge-and-deploy',
      repository: 'omnirogue/example',
      targetBranch: 'main',
      deploymentTarget: 'https://preview.example/release'
    })
  })
  it('retains feedback waiting when reopening a human-delivery outcome', () => {
    const chain = saved([
      {
        ...report,
        id: 'feedback',
        finish: 'human-handoff',
        instructions: undefined,
        conditions: [
          { id: 'handoff', kind: 'handoff', target: 'emp_review', recipientId: 'emp_review' },
          { id: 'feedback', kind: 'review', target: 'emp_review', recipientId: 'emp_review' }
        ],
        actions: []
      }
    ])
    expect(draftFromChain(chain).outcomes![0]!.finish).toMatchObject({
      kind: 'person',
      personId: 'emp_review',
      disposition: 'feedback'
    })
  })
  it('restores the signed delivery contract instead of rebuilding an empty handoff', () => {
    const chain = saved([
      {
        ...report,
        id: 'owner',
        finish: 'human-handoff',
        instructions: undefined,
        conditions: [
          { id: 'handoff', kind: 'handoff', target: 'emp_review', recipientId: 'emp_review' }
        ],
        actions: []
      }
    ])
    chain.steps = [
      {
        kind: 'handoff',
        id: 'owner_person-handoff',
        outcomeId: 'owner',
        status: 'delivered',
        handoff: {
          revision: 2,
          taskId: 'btk_existing',
          taskTitle: 'Existing card',
          sessionLabel: 'Task',
          recipients: [
            {
              employeeId: 'emp_review',
              name: 'Reviewer',
              operationId: 'operation_existing',
              delivery: 'sent',
              threadId: 'hth_existing'
            }
          ],
          action: 'edit',
          disposition: 'ownership-transfer',
          deliverables: { kind: 'files', paths: ['/work/result.md'] },
          includeSummary: false,
          note: 'Please publish this.',
          savedAt: 1
        }
      }
    ]
    const draft = draftFromChain(chain)
    expect(draft.handoff).toMatchObject({
      task: { id: 'btk_existing', title: 'Existing card' },
      deliverables: { kind: 'files', paths: ['/work/result.md'] },
      includeSummary: false,
      action: 'edit'
    })
    expect(draft.note).toBe('Please publish this.')
    expect(draft.outcomes![0]!.finish).toMatchObject({
      personName: 'Reviewer',
      action: 'edit',
      disposition: 'ownership'
    })
  })
  // Why: a next-step instruction typed in chat is filed by the agent through `omni outcome commit`
  // (source 'ai'), whose definition schema carries actions and conditions but no editor steps, and
  // whose host refuses a new handoff condition from an agent (session-outcome-inferred-authority).
  // This pins how such a set reaches the ＋ Next actions form so the gap is visible, not assumed.
  it('hydrates a reviewer action and human-handoff finish as Next Person Team without an Agent Reviewers step', () => {
    const chain = saved(
      [
        {
          id: 'chat_next',
          title: 'add a Codex reviewer, then hand off the files and the full conversation to Uma',
          finish: 'human-handoff',
          dependsOn: [],
          conditions: [
            { id: 'review', kind: 'review', target: 'chat_next', recipientId: 'emp_uma' },
            { id: 'handoff', kind: 'handoff', target: 'emp_uma', recipientId: 'emp_uma' }
          ],
          actions: [
            {
              id: 'codex_review',
              instruction: 'add a Codex reviewer',
              conditionIds: ['review'],
              authority: 'existing-user-authority',
              agent: 'codex'
            }
          ]
        }
      ],
      'ai'
    )
    const [outcome] = draftFromChain(chain).outcomes!
    // The reviewer travels as an outcome action, not as a review step: the form shows no
    // "Agent Reviewers" entry, so rounds/adversarial can only come from the user editing the form.
    expect(outcomeReviewStep(outcome!)).toBeNull()
    expect(outcome!.steps).toEqual([])
    expect(chain.outcomeSet!.outcomes[0]!.actions[0]).toMatchObject({ agent: 'codex' })
    // The person handoff does reach the form as Next Person → Team with the recipient id.
    expect(nextPersonChoice(outcome!.finish)).toBe('team')
    expect(outcome!.finish).toMatchObject({
      kind: 'person',
      personId: 'emp_uma',
      disposition: 'feedback',
      action: 'review'
    })
  })
  it('reuses existing context and never creates a task for an unlinked session', async () => {
    const draft = draftFromChain(
      saved([
        {
          ...report,
          finish: 'human-handoff',
          instructions: undefined,
          conditions: [
            { id: 'handoff', kind: 'handoff', target: 'emp_review', recipientId: 'emp_review' }
          ],
          actions: []
        }
      ])
    )
    const linked = await draftWithOutcomeHandoffContext({
      draft,
      context: {
        linked: { id: 'btk_existing', title: 'Existing' },
        deliverables: { kind: 'files', paths: ['/work/current.pdf'] }
      }
    })
    expect(linked.handoff).toMatchObject({
      task: { id: 'btk_existing', title: 'Existing' },
      deliverables: { kind: 'files', paths: ['/work/current.pdf'] }
    })

    const created = await draftWithOutcomeHandoffContext({
      draft,
      context: { linked: null, deliverables: { kind: 'files', paths: ['/work/current.pdf'] } }
    })
    expect(created.handoff.task).toBeNull()
  })
})

it('restores the reviewed fallback order from a saved outcome chain without sharing mutable arrays', () => {
  const chain = saved([report])
  const route = ['x-ai/grok-4.5', 'google/gemini-2.5-pro']
  chain.steps = [
    {
      id: 'report_handoff',
      kind: 'agent',
      outcomeId: 'report',
      agent: 'omp',
      model: `openrouter/${route[0]}`,
      openrouterCandidates: route,
      presetId: 'implement',
      prompt: 'Work',
      status: 'queued'
    }
  ]
  const actor = draftFromChain(chain).outcomes![0]!.steps[0]!
  expect(actor).toMatchObject({
    kind: 'handoff',
    actor: { model: `openrouter/${route[0]}`, openrouterCandidates: route }
  })
  if (actor.kind === 'handoff') {
    expect(actor.actor!.openrouterCandidates).not.toBe(route)
  }
})
