import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeAgentTurnFailure } from '../../shared/agent-turn-failure'
import type { SessionRunPhase } from '../../shared/session-run-lifecycle'
import {
  commitOneStagePlan,
  finiteRecoveryWorkers,
  idleHook,
  liveAttempt,
  recoveryFixture,
  runningAttempt,
  type RecoveryFixture
} from './session-outcome-attempt-recovery-test-fixture'

// The record this reproduces: a worker that dies, stalls or cannot start used to block its outcome
// with a reason, and any blocked reason read as "needs you" until a person pressed Resume. Here the
// host recovers by itself within bounds, fails honestly when it cannot, and asks nobody anything.

const fixtures: RecoveryFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).toReversed()) {
    await fixture.dispose()
  }
})

function fixture(...behaviours: Parameters<typeof recoveryFixture>[0]): RecoveryFixture {
  const f = recoveryFixture(behaviours)
  fixtures.push(f)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return f
}

/** Settle passes while recording every phase the run read as, so "never needs-you" is provable. */
function phaseLog(f: RecoveryFixture): { phases: SessionRunPhase[]; settle: () => Promise<void> } {
  const phases: SessionRunPhase[] = []
  return {
    phases,
    settle: async () => {
      await f.settle()
      phases.push(f.progress().phase)
    }
  }
}

const crash = (f: RecoveryFixture, dispatchId: string, reason = 'exited'): void => {
  f.db.failDispatch(dispatchId, 'Agent process exited with code 1', {
    workerProcessExited: true,
    terminationReason: reason
  })
}

const attention = (f: RecoveryFixture) => f.service.get('chain').outcomeSet!.attention ?? []

describe('a worker that dies', () => {
  it('is replaced by the host itself, and the run completes without asking anyone', async () => {
    const f = fixture('silent', 'succeed')
    await commitOneStagePlan(f)
    const first = await runningAttempt(f)
    const log = phaseLog(f)

    crash(f, first.dispatchId)
    await log.settle()
    const stopped = liveAttempt(f)
    expect(stopped).toMatchObject({
      id: first.id,
      state: 'blocked',
      failure: { code: 'worker-exited', detail: 'exited', at: f.now() },
      // The moment it stopped, not the moment its launch returned.
      updatedAt: f.now()
    })
    expect(f.service.get('chain').outcomeSet!.outcomes[0]!.block).toMatchObject({
      class: 'recovering',
      code: 'worker-exited',
      until: f.now() + 15_000
    })
    expect(f.progress().phase).toBe('recovering')
    expect(f.handles).toHaveLength(1)

    f.advance(15_000)
    await log.settle()
    expect(f.handles).toHaveLength(2)
    await f.settleUntil(() => f.progress().lifecycle === 'complete')

    expect(f.attempts().map((attempt) => attempt.state)).toEqual(['retryable', 'completed'])
    expect(f.handles).toHaveLength(2)
    expect(attention(f)).toEqual([])
    expect(log.phases).not.toContain('needs-you')
  })

  it('fails honestly once the bounded retries are spent, and never launches again', async () => {
    const f = fixture('report-failed', 'report-failed', 'report-failed', 'succeed')
    await commitOneStagePlan(f)
    const log = phaseLog(f)
    const blockedAttempts = (): number =>
      f.attempts().filter((attempt) => attempt.state === 'blocked').length

    await f.settleUntil(() => blockedAttempts() === 1)
    for (const backoff of [15_000, 60_000]) {
      expect(f.progress().phase).toBe('recovering')
      f.advance(backoff)
      await log.settle()
      await f.settleUntil(() => blockedAttempts() === 1 && liveAttempt(f).state === 'blocked')
    }

    expect(f.handles).toHaveLength(3)
    expect(f.attempts().map((attempt) => attempt.state)).toEqual([
      'retryable',
      'retryable',
      'blocked'
    ])
    expect(f.service.get('chain').outcomeSet!.outcomes[0]).toMatchObject({
      status: 'blocked',
      block: { class: 'failed', code: 'agent-turn-failed' }
    })
    expect(f.progress()).toMatchObject({ phase: 'failed', lifecycle: 'waiting', attention: [] })
    expect(attention(f)).toEqual([])

    // Exhausted is final for the host: however long it waits, nothing is launched again.
    for (let pass = 0; pass < 5; pass++) {
      f.advance(30 * 60_000)
      await log.settle()
      expect(f.handles).toHaveLength(3)
    }
    expect(log.phases).not.toContain('needs-you')
  })

  it('is never relaunched when its failure is older than the recovery deadline', async () => {
    const f = fixture('silent', 'succeed')
    await commitOneStagePlan(f)
    const first = await runningAttempt(f)
    crash(f, first.dispatchId)
    await f.settle()
    expect(f.progress().phase).toBe('recovering')

    // The host was away for longer than work may wait for a relaunch nobody asked for.
    f.advance(6 * 60 * 60_000 + 1)
    for (let pass = 0; pass < 3; pass++) {
      await f.settle()
    }
    expect(f.handles).toHaveLength(1)
    expect(liveAttempt(f).state).toBe('blocked')
    expect(f.service.get('chain').outcomeSet!.outcomes[0]!.block).toMatchObject({
      class: 'failed',
      code: 'worker-exited'
    })
    expect(f.progress().phase).toBe('failed')
    expect(attention(f)).toEqual([])
  })

  it('stays failed when the person closed the worker themselves', async () => {
    const f = fixture('silent', 'succeed')
    await commitOneStagePlan(f)
    const first = await runningAttempt(f)
    crash(f, first.dispatchId, 'operator_close')
    await f.settle()

    expect(liveAttempt(f).failure).toMatchObject({ code: 'operator-closed' })
    expect(f.service.get('chain').outcomeSet!.outcomes[0]!.block).toMatchObject({
      class: 'failed',
      code: 'operator-closed'
    })
    for (let pass = 0; pass < 4; pass++) {
      f.advance(60_000)
      await f.settle()
    }
    // Starting it again would undo their decision.
    expect(f.handles).toHaveLength(1)
    expect(f.progress().phase).toBe('failed')
    expect(attention(f)).toEqual([])
  })
})

describe('a worker the host cannot prove stopped', () => {
  it('is held, then failed — and never gets a second dispatch, even on Resume', async () => {
    const f = fixture('silent', 'succeed')
    await commitOneStagePlan(f)
    const first = await runningAttempt(f)
    // No hook row at all: the pane says nothing, which proves nothing.
    vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue(null)
    await f.settle()

    expect(liveAttempt(f)).toMatchObject({ id: first.id, state: 'unverifiable' })
    expect(f.service.get('chain').outcomeSet!.outcomes[0]!.block).toMatchObject({
      class: 'waiting',
      code: 'worker-unverifiable',
      wake: 'worker contact',
      until: f.now() + 10 * 60_000
    })
    expect(f.progress()).toMatchObject({ phase: 'waiting', wake: 'worker contact' })

    f.advance(10 * 60_000)
    await f.settle()
    expect(f.service.get('chain').outcomeSet!.outcomes[0]!.block).toMatchObject({
      class: 'failed',
      code: 'unverifiable-worker'
    })
    expect(f.progress().phase).toBe('failed')

    await f.service.resume('chain', f.service.get('chain').outcomeSet!.revision)
    for (let pass = 0; pass < 3; pass++) {
      f.advance(60_000)
      await f.settle()
    }
    expect(f.handles).toHaveLength(1)
    expect(liveAttempt(f)).toMatchObject({ id: first.id, state: 'unverifiable' })
    expect(attention(f)).toEqual([])
  })
})

describe('the 180 s dispatch stall', () => {
  it('reads as recovering, stops the quiet worker, and is retried — never needs-you', async () => {
    const f = fixture('silent', 'succeed')
    finiteRecoveryWorkers(f)
    await commitOneStagePlan(f)
    const first = await runningAttempt(f)
    const log = phaseLog(f)
    const hook = vi.mocked(f.runtime.getFreshAgentHookStatusForHandle)

    // Sal's chain: ready/input_accepted, no hook row, silent past the recorded 180 s budget.
    hook.mockReturnValue(null)
    f.db.db.prepare('UPDATE worker_dispatches SET updated_at = ? WHERE dispatch_id = ?').run(
      new Date(Date.now() - 600_000)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, ''),
      first.dispatchId
    )
    for (let pass = 0; pass < 6 && liveAttempt(f).failure?.code !== 'worker-stalled'; pass++) {
      await log.settle()
    }

    expect(liveAttempt(f)).toMatchObject({
      id: first.id,
      state: 'blocked',
      failure: { code: 'worker-stalled', detail: 'input_accepted_stalled' }
    })
    expect(liveAttempt(f).error).toContain('No activity was observed for 180s')
    expect(f.service.get('chain').outcomeSet!.outcomes[0]!.block).toMatchObject({
      class: 'recovering',
      code: 'worker-stalled'
    })
    expect(f.progress().phase).toBe('recovering')

    hook.mockReturnValue(idleHook())
    f.advance(15_000)
    await log.settle()
    // The watchdog only wrote rows; the quiet worker's terminal is closed before a replacement runs.
    expect(f.runtime.closeTerminal).toHaveBeenCalledWith(f.handles[0])
    expect(f.db.getWorkerTerminalResourceByOwner(first.dispatchId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released',
      archive_status: 'captured'
    })
    expect(f.handles).toHaveLength(2)

    await f.settleUntil(() => f.progress().lifecycle === 'complete')
    expect(f.attempts().map((attempt) => attempt.state)).toEqual(['retryable', 'completed'])
    expect(attention(f)).toEqual([])
    expect(log.phases).not.toContain('needs-you')
  })

  it('holds instead of relaunching when the quiet worker cannot be confirmed stopped', async () => {
    const f = fixture('silent', 'succeed')
    finiteRecoveryWorkers(f)
    await commitOneStagePlan(f)
    const first = await runningAttempt(f)
    f.db.failReadyWorkerDispatch({
      dispatchId: first.dispatchId,
      stage: 'input_accepted_stalled',
      reason: 'No activity was observed for 180s.'
    })
    vi.mocked(f.runtime.closeTerminal).mockResolvedValue({ ptyKilled: false } as never)
    await f.settle()
    f.advance(15_000)
    for (let pass = 0; pass < 3; pass++) {
      await f.settle()
    }

    expect(f.handles).toHaveLength(1)
    expect(f.runtime.closeTerminal).toHaveBeenCalledWith(f.handles[0])
    expect(liveAttempt(f)).toMatchObject({ state: 'blocked', launchDisposition: 'unverifiable' })
    expect(f.service.get('chain').outcomeSet!.outcomes[0]!.block).toMatchObject({
      class: 'waiting',
      code: 'worker-unverifiable'
    })
    expect(f.progress().phase).toBe('waiting')
  })
})

describe('a startup that is blocked', () => {
  it('retries past "Agent startup blocked: codex-hooks-review-prompt" without asking anyone', async () => {
    const f = fixture('succeed', 'succeed')
    vi.mocked(f.runtime.waitForTerminal).mockResolvedValueOnce({
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null,
      blockedReason: 'codex-hooks-review-prompt'
    } as never)
    await commitOneStagePlan(f)
    const log = phaseLog(f)
    await f.settleUntil(() => liveAttempt(f)?.state === 'blocked')

    expect(liveAttempt(f)).toMatchObject({
      error: 'Agent startup blocked: codex-hooks-review-prompt',
      failure: { code: 'startup-blocked', detail: 'codex-hooks-review-prompt' }
    })
    expect(f.progress().phase).toBe('recovering')
    // The prompt never reached the agent, so its worker never reported anything.
    expect(f.handles).toHaveLength(0)

    f.advance(15_000)
    await log.settle()
    await f.settleUntil(() => f.progress().lifecycle === 'complete')
    expect(f.handles).toHaveLength(1)
    expect(attention(f)).toEqual([])
    expect(log.phases).not.toContain('needs-you')
  })
})

describe('a provider that refuses the agent', () => {
  const QUOTA_WALL = "You're out of usage credits. Run /usage-credits to keep using this model."

  const refuse = (f: RecoveryFixture, dispatchId: string, said: string): void => {
    f.db.failReadyWorkerDispatch({
      dispatchId,
      stage: 'input_accepted_agent_failed',
      reason: describeAgentTurnFailure(said)
    })
  }

  it('backs off on a usage wall, retries, and only then asks for an account', async () => {
    const f = fixture('silent', 'silent', 'silent', 'succeed')
    await commitOneStagePlan(f)

    for (const backoff of [5 * 60_000, 20 * 60_000]) {
      const attempt = await runningAttempt(f)
      refuse(f, attempt.dispatchId, QUOTA_WALL)
      await f.settle()
      expect(liveAttempt(f).failure).toMatchObject({ code: 'provider-usage-limit' })
      expect(f.service.get('chain').outcomeSet!.outcomes[0]!.block).toMatchObject({
        class: 'recovering',
        code: 'provider-usage-limit',
        until: f.now() + backoff
      })
      expect(f.progress().phase).toBe('recovering')
      expect(attention(f)).toEqual([])
      f.advance(backoff)
    }
    const last = await runningAttempt(f)
    refuse(f, last.dispatchId, QUOTA_WALL)
    await f.settle()

    expect(f.handles).toHaveLength(3)
    expect(attention(f)).toHaveLength(1)
    expect(attention(f)[0]).toMatchObject({
      kind: 'credential',
      state: 'open',
      recipient: { type: 'owner' },
      source: { type: 'provider-usage-limit' },
      scope: { outcomeId: 'work', stepId: 'work', attemptId: last.id }
    })
    expect(f.progress()).toMatchObject({ phase: 'needs-you', lifecycle: 'needs-you' })
    for (let pass = 0; pass < 3; pass++) {
      f.advance(60 * 60_000)
      await f.settle()
    }
    expect(f.handles).toHaveLength(3)
    expect(attention(f)).toHaveLength(1)
  })

  it('asks for a sign-in at once, and tries again when the person resumes', async () => {
    const f = fixture('silent', 'succeed')
    await commitOneStagePlan(f)
    const first = await runningAttempt(f)
    refuse(f, first.dispatchId, 'Invalid API key · Please run /login')
    await f.settle()

    expect(liveAttempt(f).failure).toMatchObject({ code: 'provider-authentication' })
    expect(attention(f)).toHaveLength(1)
    const request = attention(f)[0]!
    expect(request).toMatchObject({
      kind: 'credential',
      state: 'open',
      source: { type: 'provider-authentication' },
      action: { kind: 'open-conversation' }
    })
    expect(f.progress().phase).toBe('needs-you')
    f.advance(60 * 60_000)
    await f.settle()
    expect(f.handles).toHaveLength(1)

    // "I signed in" — the person's Resume is the answer, and the request closes behind it.
    await f.service.resume('chain', f.service.get('chain').outcomeSet!.revision)
    await f.settleUntil(() => f.progress().lifecycle === 'complete')
    expect(f.handles).toHaveLength(2)
    expect(attention(f).filter((entry) => entry.state === 'open')).toEqual([])
  })
})
