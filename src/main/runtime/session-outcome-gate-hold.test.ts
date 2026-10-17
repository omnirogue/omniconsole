import { describe, expect, it } from 'vitest'
import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainHandoffStep,
  SessionChainStep
} from '../../shared/session-chain-types'
import type { SessionOutcome, SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import {
  holdStepsForGateDecision,
  releaseDecidedGateWaits,
  sessionOutcomeGateDecided,
  sessionOutcomeGateHold
} from './session-outcome-gate-hold'

const NOW = 4_000_000

const seat = (id: string, extra: Partial<SessionChainAgentStep> = {}): SessionChainAgentStep => ({
  id,
  outcomeId: 'ship',
  agent: 'codex',
  prompt: `STEP:${id}`,
  status: 'queued',
  ...extra
})

const gate = (extra: Partial<SessionChainAgentStep> = {}): SessionChainAgentStep =>
  seat('verify', { verdict: { kind: 'verify', over: ['done'], consumed: 'gate' }, ...extra })

const handoff: SessionChainHandoffStep = {
  kind: 'handoff',
  id: 'handoff',
  outcomeId: 'ship',
  status: 'queued',
  handoff: {
    revision: 1,
    taskId: null,
    taskTitle: 'Review the export',
    sessionLabel: 'Export',
    recipients: [
      { employeeId: 'emp_maya', name: 'Maya', operationId: 'operation_1', delivery: 'pending' }
    ],
    deliverables: { kind: 'files', paths: [] },
    includeSummary: false,
    note: 'Please review',
    savedAt: 1
  }
}

const judged: SessionOutcomeAttempt = {
  id: 'attempt_verify',
  outcomeId: 'ship',
  actionId: 'step_verify',
  actionKey: 'key_verify',
  outcomeRevision: 1,
  state: 'completed',
  startedAt: 1,
  updatedAt: 2
}

/** work → verify (a gate that said `status`, routed nowhere) → whatever the plan put behind it. */
function failedAt(
  behind: SessionChainStep[],
  status = 'fail',
  completed: string[] = ['work', 'verify']
): SessionChain {
  const steps: SessionChainStep[] = [seat('work'), gate(), ...behind]
  return {
    id: 'chain',
    workspacePath: '/workspace',
    worktreeId: 'workspace',
    hostId: 'local',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    auto: true,
    currentIndex: completed.length,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps,
    verdicts: [
      {
        stepId: 'verify',
        attemptId: judged.id,
        verdict: { status, blockingFindings: ['the tax column is missing'] },
        consumptionKey: 'verdict:verify:attempt_verify',
        consumedAt: NOW
      }
    ],
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1,
      removals: [],
      attempts: [judged],
      completedSteps: completed,
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
      outcomes: [
        {
          id: 'ship',
          title: 'The export balances',
          finish: 'complete',
          dependsOn: [],
          stepIds: steps.map((step) => step.id),
          conditions: [{ id: 'done', kind: 'report', target: 'verify' }],
          actions: [],
          revision: 1,
          status: 'pending',
          evidence: []
        }
      ]
    }
  }
}

const outcomeOf = (chain: SessionChain): SessionOutcome => chain.outcomeSet!.outcomes[0]!
const stopped = (chain: SessionChain): SessionChain =>
  holdStepsForGateDecision(chain, outcomeOf(chain), 'verify', NOW)
const holdOf = (chain: SessionChain) =>
  sessionOutcomeGateHold(chain, chain.outcomeSet!, outcomeOf(chain))
const decidedOf = (chain: SessionChain) =>
  sessionOutcomeGateDecided(chain, chain.outcomeSet!, outcomeOf(chain), 'verify')
const waitOf = (chain: SessionChain, id: string) =>
  (chain.steps.find((step) => step.id === id) as SessionChainAgentStep).wait

/** The owner's answer: a stage the stop never marked, appended to the plan. */
function withStage(chain: SessionChain, added: SessionChainAgentStep): SessionChain {
  return {
    ...chain,
    steps: [...chain.steps, added],
    outcomeSet: {
      ...chain.outcomeSet!,
      revision: chain.outcomeSet!.revision + 1,
      outcomes: chain.outcomeSet!.outcomes.map((outcome) => ({
        ...outcome,
        stepIds: [...(outcome.stepIds ?? []), added.id]
      }))
    }
  }
}

describe('recording the stop', () => {
  it('marks the gate and every seat still to run behind it, and nothing else', () => {
    const chain = stopped(
      failedAt([seat('publish'), seat('closed', { status: 'skipped' }), handoff, seat('announce')])
    )
    for (const id of ['verify', 'publish', 'announce']) {
      expect(waitOf(chain, id)).toEqual({ reason: 'human_decision', since: NOW, ref: 'verify' })
    }
    expect(waitOf(chain, 'work')).toBeUndefined()
    expect(waitOf(chain, 'closed')).toBeUndefined()
    expect(chain.steps.find((step) => step.id === 'handoff')).toEqual(handoff)
  })
})

describe('a gate that said no with nowhere to route it', () => {
  it('stops its outcome on every pass, in the failure’s own words', () => {
    const chain = stopped(failedAt([seat('publish')]))
    expect(holdOf(chain)).toEqual({
      kind: 'gate',
      stepId: 'verify',
      reason: 'The verification did not pass. the tax column is missing'
    })
    // Read from the record alone: a restart, or a copy that went through JSON, reads the same.
    expect(holdOf(JSON.parse(JSON.stringify(chain)) as SessionChain)).toEqual(holdOf(chain))
    expect(holdOf(stopped(failedAt([seat('publish')], 'insufficient_evidence')))).toMatchObject({
      reason: expect.stringContaining('could not judge')
    })
  })

  it('also holds back a handoff when no agent seat is left behind the gate', () => {
    expect(holdOf(stopped(failedAt([handoff])))).toMatchObject({ kind: 'gate', stepId: 'verify' })
  })

  it('is not a stop at all without the recorded marks: a routed failure, or a gate that passed', () => {
    expect(holdOf(failedAt([seat('publish')]))).toBeUndefined()
    expect(holdOf(stopped(failedAt([seat('publish')], 'pass')))).toBeUndefined()
  })

  it('leaves a finished outcome to its verification hold', () => {
    expect(
      holdOf(stopped(failedAt([seat('publish')], 'fail', ['work', 'verify', 'publish'])))
    ).toBeUndefined()
  })
})

describe('the owner’s decision', () => {
  it('is a stage the stop never marked: the run continues, and stays decided', () => {
    const decided = withStage(stopped(failedAt([seat('publish')])), seat('fix'))
    expect(holdOf(decided)).toBeUndefined()

    const released = releaseDecidedGateWaits(decided, decided.outcomeSet!)
    expect(waitOf(released, 'publish')).toBeUndefined()
    // The gate keeps its mark: the question was asked, and is not asked again.
    expect(waitOf(released, 'verify')).toMatchObject({ reason: 'human_decision', ref: 'verify' })
    expect(holdOf(released)).toBeUndefined()
    expect(releaseDecidedGateWaits(released, released.outcomeSet!)).toBe(released)

    // Still decided once the added stage has run and only the older seat is left.
    const later: SessionChain = {
      ...released,
      outcomeSet: { ...released.outcomeSet!, completedSteps: ['work', 'verify', 'fix'] }
    }
    expect(holdOf(later)).toBeUndefined()
  })

  it('is a redefined outcome: the verdict was about what the outcome used to be', () => {
    const chain = stopped(failedAt([seat('publish')]))
    const redefined: SessionChain = {
      ...chain,
      outcomeSet: {
        ...chain.outcomeSet!,
        outcomes: chain.outcomeSet!.outcomes.map((outcome) => ({ ...outcome, revision: 2 }))
      }
    }
    expect(holdOf(redefined)).toBeUndefined()
  })

  it('is a superseding plan version: the old gate is history', () => {
    expect(holdOf({ ...stopped(failedAt([seat('publish')])), planVersion: 2 })).toBeUndefined()
  })

  it('leaves the marks alone while nothing is decided', () => {
    const chain = stopped(failedAt([seat('publish')]))
    expect(releaseDecidedGateWaits(chain, chain.outcomeSet!)).toBe(chain)
  })

  it('is remembered once answered, so the finish does not ask about the same failure again', () => {
    const standing = stopped(failedAt([seat('publish')]))
    expect(decidedOf(standing)).toBe(false)

    const decided = withStage(standing, seat('fix'))
    expect(decidedOf(decided)).toBe(true)
    // Still answered once every stage has run and nothing is left to hold back.
    const finished: SessionChain = {
      ...decided,
      outcomeSet: {
        ...decided.outcomeSet!,
        completedSteps: ['work', 'verify', 'publish', 'fix']
      }
    }
    expect(holdOf(finished)).toBeUndefined()
    expect(decidedOf(finished)).toBe(true)
    // A redefined outcome is an answer too.
    expect(
      decidedOf({
        ...standing,
        outcomeSet: {
          ...standing.outcomeSet!,
          outcomes: standing.outcomeSet!.outcomes.map((outcome) => ({ ...outcome, revision: 2 }))
        }
      })
    ).toBe(true)
  })

  it('is never a seat that simply finished before the verdict', () => {
    // `publish` ran beside the gate and finished first: the stop marks it too, so it is part of
    // the stop — not a stage the owner added afterwards.
    const chain = stopped(failedAt([seat('publish')], 'fail', ['work', 'publish', 'verify']))
    expect(waitOf(chain, 'publish')).toEqual({
      reason: 'human_decision',
      since: NOW,
      ref: 'verify'
    })
    expect(decidedOf(chain)).toBe(false)
    expect(releaseDecidedGateWaits(chain, chain.outcomeSet!)).toBe(chain)
  })

  it('is never an answer for a gate at the end of the plan, or one that never stopped the run', () => {
    // Nothing behind the gate to mark: its question is still open, and the finish asks it.
    expect(decidedOf(stopped(failedAt([], 'fail', ['work', 'verify'])))).toBe(false)
    expect(decidedOf(failedAt([seat('publish')]))).toBe(false)
    expect(decidedOf(stopped(failedAt([seat('publish')], 'pass')))).toBe(false)
  })
})

describe('a host that died between the receipt and marking the gate complete', () => {
  it('keeps the marks the replay will find, and stops as soon as the gate is complete', () => {
    const replaying = stopped(failedAt([seat('publish')], 'fail', ['work']))
    // Not a stop yet — the barrier is still the gate itself, so nothing can start past it.
    expect(holdOf(replaying)).toBeUndefined()
    expect(releaseDecidedGateWaits(replaying, replaying.outcomeSet!)).toBe(replaying)
    const replayed: SessionChain = {
      ...replaying,
      outcomeSet: { ...replaying.outcomeSet!, completedSteps: ['work', 'verify'] }
    }
    expect(holdOf(replayed)).toMatchObject({ kind: 'gate', stepId: 'verify' })
  })
})
