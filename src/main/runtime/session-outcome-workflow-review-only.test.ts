import { expect, it, vi } from 'vitest'
import { prepareSessionOutcomeWorkflow } from './session-outcome-workflow-prepare'
import {
  installSessionOutcomeWorkflowPort,
  type SessionOutcomeWorkflowPort
} from './session-outcome-workflow-port'
import {
  SESSION_OUTCOME_HOST_REVIEW_REASON,
  sessionOutcomeHostRouteReason
} from '../../shared/session-outcome-host-route'
import { sessionOutcomeSetSchema } from '../../shared/session-outcome-types'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'

function reviewAfterwards(): SessionChain {
  const review = { groupId: 'g', round: 1, maxRounds: 2, candidateVersion: 'v' }
  return {
    id: 'chain',
    workspacePath: '/repo',
    worktreeId: 'tree',
    hostId: 'local',
    sourcePaneKey: 'source',
    sourceRowKey: 'source',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps: [
      {
        id: 'claude-review',
        agent: 'claude',
        model: 'sonnet',
        prompt: 'Review the finished session.',
        review: { ...review, reviewerId: 'claude' },
        status: 'queued'
      },
      {
        id: 'grok-review',
        agent: 'grok',
        model: 'grok-4.6',
        prompt: 'Review the finished session.',
        review: { ...review, reviewerId: 'grok' },
        status: 'queued'
      }
    ],
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1,
      removals: [],
      attempts: [],
      continuation: {
        owner: 'execution-host',
        hostId: 'local',
        epoch: 'epoch',
        state: 'owned',
        taskId: 'btk_card',
        principal: 'person'
      },
      outcomes: [
        {
          id: 'reviewed',
          title: 'Review the finished work',
          finish: 'my-review',
          dependsOn: [],
          stepIds: ['claude-review', 'grok-review'],
          actions: [],
          conditions: [{ id: 'review', kind: 'review', target: 'reviewers' }],
          revision: 1,
          status: 'pending',
          evidence: []
        }
      ]
    }
  }
}

function port() {
  const preview = vi.fn(async () => {
    throw new Error('A review-only plan must not ask the hub for a preview.')
  })
  installSessionOutcomeWorkflowPort({ preview } as unknown as SessionOutcomeWorkflowPort)
  return preview
}

it('routes Review afterwards on a card-attached finished session to the host executor instead of throwing', async () => {
  const preview = port()
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const prepared = await prepareSessionOutcomeWorkflow({} as OrcaRuntimeService, reviewAfterwards())
  expect(preview).not.toHaveBeenCalled()
  expect(prepared.outcomeSet!.workflow).toBeUndefined()
  expect(sessionOutcomeHostRouteReason(prepared)).toBe(SESSION_OUTCOME_HOST_REVIEW_REASON)
  expect(info).toHaveBeenCalledWith(expect.stringContaining(SESSION_OUTCOME_HOST_REVIEW_REASON))
  // No new persisted field: older clients still parse the saved set.
  expect(sessionOutcomeSetSchema.safeParse(prepared.outcomeSet).success).toBe(true)
  info.mockRestore()
})

it('keeps the host route on a later save instead of refusing the already running reviewers', async () => {
  port()
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const previous = reviewAfterwards()
  previous.outcomeSet!.attempts = [
    {
      id: 'attempt',
      outcomeId: 'reviewed',
      actionId: 'step_claude-review',
      state: 'running',
      startedAt: 1,
      updatedAt: 1
    } as never
  ]
  const prepared = await prepareSessionOutcomeWorkflow(
    {} as OrcaRuntimeService,
    reviewAfterwards(),
    previous
  )
  expect(prepared.outcomeSet!.workflow).toBeUndefined()
})
