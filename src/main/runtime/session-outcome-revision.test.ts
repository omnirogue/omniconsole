import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
import { describe, expect, it } from 'vitest'
import type { SessionChain, SessionChainStep } from '../../shared/session-chain-types'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'
import {
  reconcileSessionOutcomeSteps,
  sessionOutcomeStepSignature
} from './session-outcome-revision'

function chain(steps: SessionChainStep[]): SessionChain {
  return {
    id: 'chain',
    workspacePath: '/work',
    worktreeId: 'folder:/work',
    hostId: 'local',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    auto: true,
    steps,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      outcomes: [],
      removals: [],
      attempts: [],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
      updatedAt: 1
    }
  }
}

function commit(stepIds: string[]): SessionOutcomeCommit {
  return {
    source: 'user',
    expectedRevision: 1,
    outcomes: [
      {
        id: 'outcome',
        title: 'Outcome',
        finish: 'human-handoff',
        dependsOn: [],
        stepIds,
        conditions: [],
        actions: []
      }
    ]
  }
}

function handoff(id: string, name = 'Sal'): SessionChainStep {
  return {
    kind: 'handoff',
    id,
    outcomeId: 'outcome',
    status: 'delivered',
    handoff: {
      revision: 1,
      taskId: 'btk_1',
      taskTitle: 'Card',
      sessionLabel: 'Session',
      recipients: [
        {
          employeeId: 'emp_sal',
          name,
          operationId: 'operation_original',
          delivery: 'sent',
          threadId: 'hth_existing'
        }
      ],
      action: 'review',
      disposition: 'ownership-transfer',
      deliverables: { kind: 'files', paths: ['/work/result.md'] },
      includeSummary: false,
      note: 'Review this.',
      savedAt: 1
    }
  }
}

describe('session outcome step reconciliation', () => {
  it('preserves legacy signature bytes when source repair metadata is absent', () => {
    const review: SessionChainStep = {
      id: 'review',
      agent: 'codex',
      prompt: 'Review.',
      status: 'queued',
      review: { groupId: 'g', reviewerId: 'r', round: 1, maxRounds: 3, candidateVersion: 'v1' }
    }
    expect(sessionOutcomeStepSignature(review)).toBe(
      '["codex","Review.",null,null,null,null,null,null,["g","r",1,3,null],null]'
    )
    const repair: SessionChainStep = {
      id: 'repair',
      agent: 'codex',
      prompt: 'Repair.',
      status: 'queued',
      reviewRepair: { groupId: 'g', afterRound: 1, candidateVersion: 'v1', consumptionKey: 'key' }
    }
    expect(sessionOutcomeStepSignature(repair)).toBe(
      '["codex","Repair.",null,null,null,null,null,null,null,["g",1]]'
    )
  })

  it('does not turn an attested chat review request into original-builder repair authority', () => {
    const review: SessionChainStep = {
      id: 'review',
      outcomeId: 'outcome',
      agent: 'codex',
      prompt: 'Review the finished report.',
      status: 'queued',
      review: {
        groupId: 'group',
        reviewerId: 'reviewer',
        round: 1,
        maxRounds: 3,
        repairWithSource: true,
        candidateVersion: 'v1'
      }
    }
    const input = { ...commit(['review']), source: 'ai' as const }
    expect(() =>
      reconcileSessionOutcomeSteps(chain([review]), undefined, input, review.prompt)
    ).toThrow('AI cannot add original-builder repair authority')
    const old = chain([review])
    expect(reconcileSessionOutcomeSteps(chain([review]), old, input, review.prompt).steps).toEqual(
      old.steps
    )
    const expanded = { ...review, review: { ...review.review!, maxRounds: 5 } }
    expect(() =>
      reconcileSessionOutcomeSteps(chain([expanded]), old, input, review.prompt)
    ).toThrow('AI cannot add original-builder repair authority')
  })

  it('maps a no-op recompile onto the delivered handoff and keeps its operation receipt', () => {
    const old = chain([handoff('random_old')])
    const fresh = handoff('outcome_person-handoff')
    fresh.status = 'queued'
    if (fresh.kind === 'handoff') {
      fresh.handoff.recipients[0] = {
        employeeId: 'emp_sal',
        name: 'Sal',
        operationId: 'operation_new',
        delivery: 'pending'
      }
    }
    const result = reconcileSessionOutcomeSteps(
      chain([fresh]),
      old,
      commit(['outcome_person-handoff'])
    )
    expect(result.steps).toEqual(old.steps)
    expect(result.input.outcomes[0]!.stepIds).toEqual(['random_old'])
  })

  it('does not rerun a finished review when an unrelated outcome is inserted', () => {
    const review: SessionChainStep = {
      id: 'review_stable',
      outcomeId: 'outcome',
      agent: 'codex',
      prompt: 'Review.',
      status: 'launched',
      launchedPaneKey: 'review-pane',
      review: {
        groupId: 'review_group',
        reviewerId: 'reviewer:1',
        round: 1,
        maxRounds: 1,
        candidateVersion: 'version'
      }
    }
    const old = chain([review])
    const result = reconcileSessionOutcomeSteps(
      chain([{ ...review, status: 'queued', launchedPaneKey: undefined }]),
      old,
      commit(['review_stable'])
    )
    expect(result.steps).toEqual([review])
  })

  it('refuses an edit or removal while delivery is uncertain', () => {
    const uncertain = handoff('handoff')
    if (uncertain.kind === 'handoff') {
      uncertain.status = 'queued'
      uncertain.handoff.recipients[0]!.delivery = 'sending'
    }
    const old = chain([uncertain])
    const changed = handoff('handoff')
    if (changed.kind === 'handoff') {
      changed.handoff.action = 'edit'
    }
    expect(() => reconcileSessionOutcomeSteps(chain([changed]), old, commit(['handoff']))).toThrow(
      'may already be in progress'
    )
    expect(() => reconcileSessionOutcomeSteps(chain([]), old, commit([]))).toThrow(
      'may already be in progress'
    )
  })
})

it('refuses an AI commit that adds a review round or parallel group, but keeps quoted plain steps', () => {
  const authority = 'Please review the change carefully before merging it'
  const reviewer: SessionChainStep = {
    id: 'review',
    outcomeId: 'outcome',
    agent: 'codex',
    prompt: 'Please review the change carefully',
    status: 'queued',
    group: 'review_round_1',
    review: {
      groupId: 'review',
      reviewerId: 'review',
      round: 1,
      maxRounds: 1,
      candidateVersion: 'unbound'
    }
  }
  const aiCommit: SessionOutcomeCommit = { ...commit(['review']), source: 'ai' }

  expect(() =>
    reconcileSessionOutcomeSteps(chain([reviewer]), chain([]), aiCommit, authority)
  ).toThrow('AI cannot add parallel groups or review rounds')
  expect(() =>
    reconcileSessionOutcomeSteps(
      chain([{ ...reviewer, review: undefined }]),
      chain([]),
      aiCommit,
      authority
    )
  ).toThrow('AI cannot add parallel groups or review rounds')
  const plain = { ...reviewer, group: undefined, review: undefined }
  expect(
    reconcileSessionOutcomeSteps(chain([plain]), chain([]), aiCommit, authority).steps
  ).toHaveLength(1)
})

it('retains old receipts but creates fresh review identities when their producer instructions change', () => {
  const { workflow } = workflowProofFixture()
  const old = chain([
    {
      id: 'producer',
      agent: 'codex',
      model: 'gpt-5.6-terra',
      prompt: 'Original implementation',
      status: 'launched'
    },
    ...['astra', 'sol'].map((id) => ({
      id,
      agent: 'codex' as const,
      model: id === 'astra' ? 'gpt-6-astra' : 'gpt-5.6-sol',
      prompt: 'Review the actual candidate.',
      status: 'launched' as const,
      review: {
        groupId: 'review',
        reviewerId: id,
        round: 1,
        maxRounds: 1,
        candidateVersion: 'old-sha'
      }
    }))
  ])
  old.outcomeSet!.workflow = workflow
  old.outcomeSet!.completedSteps = ['producer', 'astra', 'sol']
  const edited = structuredClone(old)
  if (edited.steps[0]!.kind !== 'handoff') {
    edited.steps[0]!.prompt = 'Changed implementation'
  }
  const priorReceipts = structuredClone(workflow.receipts)
  const result = reconcileSessionOutcomeSteps(edited, old, commit(['producer', 'astra', 'sol']))
  expect(result.steps.map((step) => step.id)).not.toEqual(old.steps.map((step) => step.id))
  expect(result.steps.every((step) => !old.outcomeSet!.completedSteps!.includes(step.id))).toBe(
    true
  )
  expect(result.steps.map((step) => step.status)).toEqual(['queued', 'queued', 'queued'])
  expect(result.input.outcomes[0]!.stepIds).toEqual(result.steps.map((step) => step.id))
  expect(old.outcomeSet!.workflow!.receipts).toEqual(priorReceipts)
})
