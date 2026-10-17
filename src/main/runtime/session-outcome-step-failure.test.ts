import { describe, expect, it } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcome, SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { advanceSessionOutcomeSteps } from './session-outcome-steps'
import type { OrcaRuntimeService } from './omni-runtime'
import type { OutcomeStepAccess } from './session-outcome-step-progress'

// Why: an outcome-bound step carried no status at all. When its worker dispatch failed (the agent
// died on a quota wall), the outcome was blocked but the step stayed `queued` — so the plan still
// read as "two steps to come" with nothing running.
const outcome: SessionOutcome = {
  id: 'outcome_1',
  title: 'Ship the plan',
  finish: 'complete',
  dependsOn: [],
  stepIds: ['step_1', 'step_2'],
  conditions: [{ id: 'cond_1', kind: 'file', target: '/work/plan.md' }],
  actions: [],
  revision: 1,
  status: 'running',
  evidence: []
}

function attempt(overrides: Partial<SessionOutcomeAttempt>): SessionOutcomeAttempt {
  return {
    id: 'attempt_1',
    outcomeId: 'outcome_1',
    actionId: 'step_step_1',
    actionKey: 'key',
    outcomeRevision: 1,
    state: 'blocked',
    startedAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

function chain(attempts: SessionOutcomeAttempt[]): SessionChain {
  return {
    id: 'chn_5b6976342e68',
    workspacePath: '/work',
    worktreeId: 'repo::worktree',
    hostId: null,
    sourcePaneKey: 'tab-0:00000000-0000-4000-8000-000000000000',
    sourceRowKey: 'row',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    error: null,
    createdAt: 1,
    updatedAt: 1,
    steps: [
      { id: 'step_1', agent: 'claude', prompt: 'write the plan', status: 'queued' },
      { id: 'step_2', agent: 'claude', prompt: 'review the plan', status: 'queued' }
    ],
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      outcomes: [outcome],
      removals: [],
      attempts,
      continuation: {
        owner: 'execution-host',
        hostId: 'local',
        epoch: 'epoch_1',
        state: 'owned',
        sourceReady: true
      }
    } as unknown as SessionChain['outcomeSet']
  }
}

function access(initial: SessionChain): OutcomeStepAccess & { current: () => SessionChain } {
  let held = initial
  return {
    runtime: {} as OrcaRuntimeService,
    read: () => held,
    save: (next) => {
      held = next
    },
    persistAttempt: () => {},
    current: () => held
  }
}

describe('advanceSessionOutcomeSteps step failure', () => {
  it('marks the step failed when its attempt settled as blocked', async () => {
    const harness = access(
      chain([
        attempt({
          state: 'blocked',
          error: 'The agent stopped without finishing: quota.',
          failure: { code: 'provider-usage-limit', at: 2 }
        })
      ])
    )
    expect(await advanceSessionOutcomeSteps(harness, outcome)).toEqual({
      acted: true,
      launched: 0
    })
    expect(harness.current().steps[0]).toMatchObject({ id: 'step_1', status: 'failed' })
    // The reason is a diagnostic; the class says the recovery ladder owns what happens next, so a
    // dead worker is never a request for the person.
    expect(harness.current().outcomeSet!.outcomes[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'The agent stopped without finishing: quota.',
      block: { class: 'recovering', code: 'provider-usage-limit' }
    })
  })

  it('reads a stopped attempt of an older outcome revision as the failure it is', async () => {
    const harness = access(
      chain([attempt({ state: 'blocked', error: 'The worker died.', outcomeRevision: 7 })])
    )
    await advanceSessionOutcomeSteps(harness, outcome)
    // Nobody recovers an attempt the ladder does not own, so it must not read as recovering.
    expect(harness.current().outcomeSet!.outcomes[0]).toMatchObject({
      status: 'blocked',
      block: { class: 'failed', code: 'unclassified' }
    })
  })

  it('leaves a running step alone when its agent is only asking the person something', async () => {
    const harness = access(
      chain([
        attempt({
          state: 'running',
          awaiting: { kind: 'clarification', prompt: 'Which database should I use?', since: 2 }
        })
      ])
    )
    expect(await advanceSessionOutcomeSteps(harness, outcome)).toEqual({
      acted: true,
      launched: 0
    })
    expect(harness.current().steps[0]).toMatchObject({ id: 'step_1', status: 'queued' })
    // An asking agent is alive: nothing here blocks the outcome, the status recompute opens the
    // request from `awaiting`.
    expect(harness.current().outcomeSet!.outcomes[0]!.status).toBe('running')
  })

  it('never reads a live worker as failed because of the words on its attempt', async () => {
    const harness = access(
      chain([attempt({ state: 'running', error: 'Agent became ready after a slow start.' })])
    )
    await advanceSessionOutcomeSteps(harness, outcome)
    expect(harness.current().steps[0]).toMatchObject({ id: 'step_1', status: 'queued' })
    expect(harness.current().outcomeSet!.outcomes[0]).toMatchObject({ status: 'running' })
    expect(harness.current().outcomeSet!.outcomes[0]!.block).toBeUndefined()
  })
})
