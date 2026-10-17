import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeAttempt, SessionOutcomeSet } from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'

const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  settle: vi.fn(),
  trust: vi.fn()
}))
// The proof re-verification and the worker stop reach the file system and live terminals; this
// suite is about what the ladder DOES with their answers.
vi.mock('./session-outcome-attempt-evidence', () => ({
  settleProvenSessionOutcomeAttempt: mocks.settle
}))
vi.mock('./session-outcome-attempt-stop', () => ({ stopSessionAttemptWorker: mocks.stop }))
vi.mock('../agent-trust-presets', () => ({ markCodexProjectTrusted: mocks.trust }))

import {
  recoverSessionOutcomeAttempts,
  sessionAttemptRecoveryDecision,
  sessionOutcomePassClock,
  UNCONFIRMED_WORKER_STOP
} from './session-outcome-attempt-recovery'

const NOW = 10_000_000

const settledDeadWorker = {
  getOrchestrationDb: () => ({
    getDispatchContextById: () => ({ task_id: 'task_1' }),
    getWorkerDispatch: () => ({ state: 'failed' }),
    getTask: () => ({ status: 'failed' })
  })
} as unknown as OrcaRuntimeService

function attempt(overrides: Partial<SessionOutcomeAttempt> = {}): SessionOutcomeAttempt {
  return {
    id: 'attempt_1',
    outcomeId: 'ship',
    actionId: 'step_seat',
    actionKey: 'seat',
    outcomeRevision: 1,
    state: 'blocked',
    launchDisposition: 'started',
    dispatchId: 'ctx_1',
    error: 'Agent process exited with code 1',
    failure: { code: 'worker-exited', at: NOW - 60_000 },
    startedAt: 1,
    updatedAt: NOW - 60_000,
    ...overrides
  }
}

function scenario(
  attempts: SessionOutcomeAttempt[],
  extra: { chain?: Partial<SessionChain>; set?: Partial<SessionOutcomeSet> } = {}
): { chain: SessionChain; set: SessionOutcomeSet } {
  const set = {
    revision: 1,
    outcomes: [
      {
        id: 'ship',
        title: 'Ship it',
        finish: 'complete',
        dependsOn: [],
        stepIds: ['seat'],
        conditions: [],
        actions: [],
        revision: 1,
        status: 'blocked',
        blockedReason: 'Agent process exited with code 1',
        block: { class: 'recovering', code: 'worker-exited', since: NOW - 60_000 },
        evidence: []
      }
    ],
    attempts,
    continuation: { state: 'owned' },
    ...extra.set
  } as unknown as SessionOutcomeSet
  const chain = {
    id: 'chain',
    workspacePath: '/workspace',
    state: 'waiting',
    steps: [],
    ...extra.chain,
    outcomeSet: set
  } as unknown as SessionChain
  return { chain, set }
}

const recover = (
  input: ReturnType<typeof scenario>,
  options: { userInitiated?: boolean; inFlight?: (id: string) => boolean; now?: number } = {}
): Promise<SessionOutcomeSet> =>
  recoverSessionOutcomeAttempts({
    runtime: settledDeadWorker,
    chain: input.chain,
    set: input.set,
    now: options.now ?? NOW,
    ...(options.userInitiated ? { userInitiated: true } : {}),
    ...(options.inFlight ? { inFlight: options.inFlight } : {})
  })

beforeEach(() => {
  mocks.stop.mockReset().mockResolvedValue('stopped')
  mocks.trust.mockReset().mockResolvedValue(undefined)
  mocks.settle
    .mockReset()
    .mockImplementation(async (_runtime, _chain, set) => ({ set, settled: false }))
})

describe('the recovery ladder, applied', () => {
  it('replaces a provably dead worker once its backoff is due, through the retryable primitive', async () => {
    const input = scenario([attempt()])
    const set = await recover(input)
    expect(set.attempts[0]).toMatchObject({ state: 'retryable', error: undefined })
    // Why it was replaced stays on the record.
    expect(set.attempts[0]!.failure).toMatchObject({ code: 'worker-exited' })
    expect(set.outcomes[0]).toMatchObject({
      status: 'pending',
      blockedReason: undefined,
      block: undefined
    })
    // The process exited by itself: there is no terminal left to stop.
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  it('does nothing while the backoff is still running', async () => {
    const input = scenario([
      attempt({ failure: { code: 'worker-exited', at: NOW - 1_000 }, updatedAt: NOW - 1_000 })
    ])
    expect(await recover(input)).toBe(input.set)
  })

  it('lets completion evidence win over a relaunch', async () => {
    const input = scenario([attempt()])
    const proven = {
      ...input.set,
      attempts: [{ ...input.set.attempts[0]!, state: 'completed' as const, error: undefined }]
    }
    mocks.settle.mockResolvedValueOnce({ set: proven, settled: true })
    const set = await recover(input)
    expect(set.attempts).toHaveLength(1)
    expect(set.attempts[0]!.state).toBe('completed')
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  it('reads the evidence the moment an attempt is first seen stopped, not on every idle pass', async () => {
    const fresh = attempt({ failure: { code: 'worker-exited', at: NOW }, updatedAt: NOW })
    await recover(scenario([fresh]))
    expect(mocks.settle).toHaveBeenCalledTimes(1)
    mocks.settle.mockClear()
    // A later pass inside the backoff has nothing new to prove and nothing to relaunch.
    await recover(scenario([fresh]), { now: NOW + 2_000 })
    expect(mocks.settle).not.toHaveBeenCalled()
  })
})

describe('no second agent beside a quiet live one', () => {
  const stalled = attempt({
    error: 'No activity was observed for 180s',
    failure: { code: 'worker-stalled', detail: 'input_accepted_stalled', at: NOW - 60_000 }
  })

  it('stops the stalled worker before its replacement starts', async () => {
    const set = await recover(scenario([stalled]))
    expect(mocks.stop).toHaveBeenCalledWith(
      settledDeadWorker,
      expect.objectContaining({ id: 'attempt_1', dispatchId: 'ctx_1' })
    )
    expect(set.attempts[0]!.state).toBe('retryable')
  })

  it('waits without a record while the owned release is still pending, then retries', async () => {
    mocks.stop.mockResolvedValue('pending')
    const input = scenario([stalled])
    const set = await recover(input)
    // Untouched: still blocked, not poisoned, no replacement yet.
    expect(set.attempts).toEqual(input.set.attempts)
    expect(set.attempts[0]).toMatchObject({ state: 'blocked', launchDisposition: 'started' })
    expect(set.attempts[0]!.error).not.toBe(UNCONFIRMED_WORKER_STOP)
    // The next pass asks again; once the release settles the retry proceeds as usual.
    mocks.stop.mockResolvedValue('stopped')
    const again = await recover({ chain: input.chain, set })
    expect(mocks.stop).toHaveBeenCalledTimes(2)
    expect(again.attempts[0]!.state).toBe('retryable')
  })

  it('holds instead of relaunching when the stop cannot be confirmed', async () => {
    mocks.stop.mockResolvedValue('unknown')
    const input = scenario([stalled])
    const set = await recover(input)
    expect(set.attempts[0]).toMatchObject({
      state: 'blocked',
      launchDisposition: 'unverifiable',
      error: UNCONFIRMED_WORKER_STOP
    })
    // Recorded on the attempt: every later pass — and a person's Resume — holds or fails it, and
    // none of them ever relaunches.
    expect(sessionAttemptRecoveryDecision(settledDeadWorker, set, set.attempts[0]!, NOW)).toEqual({
      kind: 'hold',
      until: NOW - 60_000 + 10 * 60_000
    })
    const again = await recover({ chain: input.chain, set }, { userInitiated: true })
    expect(again.attempts.map((entry) => entry.state)).toEqual(['blocked'])
    expect(mocks.stop).toHaveBeenCalledTimes(1)
  })
})

describe('what the ladder never touches', () => {
  it('ignores attempts of a superseded plan version, an older revision, or already superseded', async () => {
    const input = scenario(
      [
        attempt({ id: 'old_plan', planVersion: 1 }),
        attempt({ id: 'old_revision', planVersion: 2, outcomeRevision: 7 }),
        attempt({ id: 'superseded', planVersion: 2, state: 'superseded' })
      ],
      { chain: { planVersion: 2 } }
    )
    expect(await recover(input)).toBe(input.set)
    expect(mocks.settle).not.toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  it('never restarts anything of a sealed or a cancelled run', async () => {
    const sealed = scenario([attempt()], {
      set: { completion: { at: 1, outcomes: [{ id: 'ship', revision: 1 }], evidenceIds: [] } }
    })
    expect(await recover(sealed, { userInitiated: true })).toBe(sealed.set)
    const cancelled = scenario([attempt()], { chain: { state: 'cancelled' } })
    expect(await recover(cancelled)).toBe(cancelled.set)
  })

  it('leaves a launch this host is still waiting on alone', async () => {
    const input = scenario([attempt()])
    expect(await recover(input, { inFlight: (id) => id === 'attempt_1' })).toBe(input.set)
  })
})

describe('the bound, and what a person’s Resume lifts', () => {
  const spent = (id: string): SessionOutcomeAttempt =>
    attempt({ id, state: 'retryable', error: undefined })

  it('stops replacing after the bounded retries of one lineage', async () => {
    const input = scenario([spent('a'), spent('b'), attempt()])
    expect(await recover(input)).toBe(input.set)
    // A retry spent on another plan version is not this lineage's.
    const other = scenario([spent('a'), { ...spent('b'), planVersion: 2 }, attempt()])
    expect((await recover(other)).attempts[2]!.state).toBe('retryable')
  })

  it('retries past the bound when the person says so, and reaches attempts the host ignores', async () => {
    const input = scenario([
      spent('a'),
      spent('b'),
      attempt(),
      attempt({ id: 'old', outcomeRevision: 7 })
    ])
    const set = await recover(input, { userInitiated: true })
    expect(set.attempts.map((entry) => entry.state)).toEqual([
      'retryable',
      'retryable',
      'retryable',
      'retryable'
    ])
  })

  it('asks for a shorter stage by itself, and tries again when the person resumes', async () => {
    const refused = attempt({
      dispatchId: undefined,
      launchDisposition: 'not-started',
      failure: { code: 'brief-too-large', at: NOW - 60_000 }
    })
    const input = scenario([refused])
    expect(
      sessionAttemptRecoveryDecision(settledDeadWorker, input.set, refused, NOW)
    ).toMatchObject({ kind: 'attention', requirement: 'brief-too-large' })
    expect(await recover(input)).toBe(input.set)
    expect((await recover(input, { userInitiated: true })).attempts[0]!.state).toBe('retryable')
  })

  it('pre-trusts the workspace before relaunching past a Codex trust prompt', async () => {
    const input = scenario([
      attempt({
        failure: { code: 'startup-blocked', detail: 'codex-trust-workspace', at: NOW - 60_000 }
      })
    ])
    const set = await recover(input)
    expect(mocks.trust).toHaveBeenCalledWith('/workspace')
    expect(set.attempts[0]!.state).toBe('retryable')
  })
})

describe('the pass clock', () => {
  it('prefers an explicit time, then the service clock, then the wall clock', () => {
    expect(sessionOutcomePassClock({ now: () => 5 }, 9)).toBe(9)
    expect(sessionOutcomePassClock({ now: () => 5 })).toBe(5)
    const before = Date.now()
    expect(sessionOutcomePassClock({})).toBeGreaterThanOrEqual(before)
  })
})
