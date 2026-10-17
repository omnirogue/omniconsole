/**
 * Whose seat is running, and whose verdict is whose.
 *
 * The per-seat rows were built by walking the seats that HAVE an attempt and indexing the seat
 * list by that walk's position, so a stage whose second seat has not started yet folded the
 * third seat's attempt — and the third seat's verdict — onto the second seat's id. The row then
 * named the wrong seat, and `up-next-blocks.ts` dropped whichever id no longer belonged to the
 * stage. Every fact about a seat is read through the seat's own id.
 */
import { expect, it } from 'vitest'
import { sessionOutcomeStepActionId } from '../../shared/session-outcome-identity'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { upNextStepReading } from './up-next-step-state'

const NOW = 1_700_000_000_000

const seat = (id: string): SessionChainAgentStep =>
  ({
    id,
    agent: 'claude',
    prompt: 'Review it.',
    presetId: 'review',
    status: 'queued',
    stage: { id: 'stage-1', shape: 'parallel', width: 3 }
  }) as SessionChainAgentStep

const attempt = (stepId: string, state: SessionOutcomeAttempt['state']): SessionOutcomeAttempt =>
  ({
    id: `attempt-${stepId}`,
    outcomeId: 'o1',
    actionId: sessionOutcomeStepActionId(stepId),
    actionKey: `k-${stepId}`,
    outcomeRevision: 1,
    state,
    startedAt: NOW - 60_000,
    updatedAt: NOW - 10_000
  }) as SessionOutcomeAttempt

/** Three reviewers; the middle one has not been launched yet, and the last one has answered. */
function chain(): SessionChain {
  return {
    id: 'source_1',
    workspacePath: '/w',
    worktreeId: 'wt',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: JSON.stringify(['local', 'wt', 'tab-1:leaf-1']),
    auto: true,
    steps: [seat('s1'), seat('s2'), seat('s3')],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: NOW - 10_000,
    verdicts: [
      {
        stepId: 's3',
        attemptId: 'attempt-s3',
        verdict: { kind: 'review', status: 'pass', summary: 'Third reviewer: no blockers.' },
        consumptionKey: 'verdict:s3:attempt-s3',
        consumedAt: NOW - 10_000
      }
    ],
    outcomeSet: {
      schemaVersion: 1,
      revision: 3,
      outcomes: [
        {
          id: 'o1',
          title: 'It passes',
          finish: 'my-review',
          dependsOn: [],
          conditions: [{ id: 'c1', kind: 'review', target: 'me' }],
          actions: [],
          revision: 1,
          status: 'pending',
          evidence: []
        }
      ],
      removals: [],
      attempts: [attempt('s1', 'running'), attempt('s3', 'completed')],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'e1', state: 'owned' },
      updatedAt: NOW - 10_000
    }
  } as unknown as SessionChain
}

it('names the seat each attempt and verdict belongs to when one seat has not started', () => {
  const reading = upNextStepReading(chain(), [seat('s1'), seat('s2'), seat('s3')], NOW)

  expect(reading.progress?.seats).toEqual([
    { id: 's1', state: 'running' },
    { id: 's3', state: 'done', verdict: 'Third reviewer: no blockers.' }
  ])
})
