import { expect, it } from 'vitest'
import {
  SESSION_OUTCOME_HOST_REVIEW_REASON,
  sessionOutcomeHostRouteReason
} from './session-outcome-host-route'
import type { SessionChain } from './session-chain-types'

function plan(steps: SessionChain['steps'], extra: Record<string, unknown> = {}) {
  return {
    steps,
    outcomeSet: {
      continuation: { taskId: 'btk_card' },
      outcomes: [{ id: 'o', stepIds: steps.map((step) => step.id) }],
      ...extra
    }
  } as unknown as Pick<SessionChain, 'steps' | 'outcomeSet'>
}

const review = { groupId: 'g', reviewerId: 'r', round: 1, maxRounds: 1, candidateVersion: 'v' }
const reviewer = { id: 'r', agent: 'claude', prompt: 'Review', status: 'queued', review } as never
const producer = { id: 'p', agent: 'codex', prompt: 'Build', status: 'queued' } as never

it('names the host route for a card-attached review with no producer stage', () => {
  expect(sessionOutcomeHostRouteReason(plan([reviewer]))).toBe(SESSION_OUTCOME_HOST_REVIEW_REASON)
})

it('leaves producer-first, unattached and already admitted plans on their own route', () => {
  expect(sessionOutcomeHostRouteReason(plan([producer, reviewer]))).toBeNull()
  const unattached = plan([reviewer])
  unattached.outcomeSet!.continuation.taskId = undefined
  expect(sessionOutcomeHostRouteReason(unattached)).toBeNull()
  expect(sessionOutcomeHostRouteReason(plan([reviewer], { workflow: {} }))).toBeNull()
})
