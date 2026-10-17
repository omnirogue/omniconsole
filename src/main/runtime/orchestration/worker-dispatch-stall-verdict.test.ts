import { describe, expect, it } from 'vitest'
import {
  HEARTBEAT_PROTOCOL_SILENCE_MS,
  isWorkerDispatchStallVerdict,
  judgeWorkerDispatchStall
} from './worker-dispatch-stall-verdict'

const NOW = 1_800_000_000_000
const TIMEOUT_MS = 180_000

function subject(overrides: { updatedAtMs?: number; timeoutMs?: number | null } = {}) {
  return {
    dispatchId: 'ctx_bc1fc8466e9f',
    stage: 'input_accepted',
    updatedAtMs: overrides.updatedAtMs ?? NOW - TIMEOUT_MS - 1_000,
    timeoutMs: overrides.timeoutMs === undefined ? TIMEOUT_MS : overrides.timeoutMs
  }
}

describe('judgeWorkerDispatchStall', () => {
  it('fails a dispatch that has been silent past its own recorded timeout', () => {
    const verdict = judgeWorkerDispatchStall(subject(), null, NOW)
    expect(verdict.kind).toBe('fail')
    expect(verdict.kind === 'fail' && verdict.stage).toBe('input_accepted_stalled')
    expect(verdict.kind === 'fail' && verdict.reason).toContain('180s')
  })

  it('keeps a dispatch still inside its own budget', () => {
    expect(judgeWorkerDispatchStall(subject({ updatedAtMs: NOW - 10_000 }), null, NOW)).toEqual({
      kind: 'keep'
    })
  })

  it('never fails a dispatch with no recorded timeout', () => {
    expect(judgeWorkerDispatchStall(subject({ timeoutMs: null }), null, NOW)).toEqual({
      kind: 'keep'
    })
  })

  it('keeps a working agent however long it has been quiet', () => {
    // A ten-minute test run emits no hook events at all; quiet is not death.
    expect(
      judgeWorkerDispatchStall(
        subject({ updatedAtMs: NOW - 60 * 60_000 }),
        { state: 'working', updatedAt: NOW - 59 * 60_000 },
        NOW
      )
    ).toEqual({ kind: 'keep' })
  })

  it('keeps an agent that is waiting on the person', () => {
    expect(
      judgeWorkerDispatchStall(subject(), { state: 'waiting', updatedAt: NOW - 600_000 }, NOW)
    ).toEqual({ kind: 'keep' })
  })

  it('parks an interrupted turn instead of failing it', () => {
    expect(
      judgeWorkerDispatchStall(
        subject(),
        { state: 'done', interrupted: true, updatedAt: NOW - 600_000 },
        NOW
      )
    ).toEqual({ kind: 'keep' })
  })

  it('fails immediately on a reported turn failure and surfaces its reason', () => {
    const verdict = judgeWorkerDispatchStall(
      subject({ updatedAtMs: NOW - 9_000 }),
      {
        state: 'done',
        failed: true,
        failureReason:
          "You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models.",
        updatedAt: NOW - 1_000
      },
      NOW
    )
    expect(verdict.kind).toBe('fail')
    expect(verdict.kind === 'fail' && verdict.stage).toBe('input_accepted_agent_failed')
    expect(verdict.kind === 'fail' && verdict.reason).toContain('out of usage credits')
    expect(verdict.kind === 'fail' && verdict.reason).toContain('another eligible account')
  })

  it('fails loudly when a turn died with no reason at all', () => {
    const verdict = judgeWorkerDispatchStall(
      subject({ updatedAtMs: NOW - 9_000 }),
      { state: 'done', failed: true, updatedAt: NOW - 1_000 },
      NOW
    )
    expect(verdict.kind).toBe('fail')
    expect(verdict.kind === 'fail' && verdict.reason).toContain('reported no reason')
  })

  it('ignores a failed turn that predates this dispatch’s last progress', () => {
    // A reused pane's older death must not fail the work that has run since.
    expect(
      judgeWorkerDispatchStall(
        subject({ updatedAtMs: NOW - 10_000 }),
        { state: 'done', failed: true, updatedAt: NOW - 600_000 },
        NOW
      )
    ).toEqual({ kind: 'keep' })
  })

  it('fails an idle turn that never reported a result once the budget expires', () => {
    const verdict = judgeWorkerDispatchStall(
      subject(),
      { state: 'done', updatedAt: NOW - TIMEOUT_MS - 500 },
      NOW
    )
    expect(verdict.kind).toBe('fail')
    expect(verdict.kind === 'fail' && verdict.reason).toContain('without reporting a result')
  })

  it('measures an idle turn from the later of the dispatch and the pane', () => {
    expect(
      judgeWorkerDispatchStall(subject(), { state: 'done', updatedAt: NOW - 1_000 }, NOW)
    ).toEqual({ kind: 'keep' })
  })

  it('never calls an agent dead while it is visibly waiting on an interactive prompt', () => {
    // No hook row at all (Codex drops untrusted hooks) and long past the budget — but the pane
    // shows a prompt only a person may answer. That is a live agent asking, not a stalled one.
    expect(judgeWorkerDispatchStall(subject(), null, NOW, 'waiting')).toEqual({ kind: 'keep' })
    expect(
      judgeWorkerDispatchStall(
        subject(),
        { state: 'done', updatedAt: NOW - TIMEOUT_MS - 500 },
        NOW,
        'waiting'
      )
    ).toEqual({ kind: 'keep' })
  })

  it('does not fail on silence while the reading of the pane is still on its way', () => {
    expect(judgeWorkerDispatchStall(subject(), null, NOW, 'pending')).toEqual({ kind: 'keep' })
  })

  it('fails the silent dispatch once the pane is read and shows no prompt', () => {
    const verdict = judgeWorkerDispatchStall(subject(), null, NOW, 'none')
    expect(verdict).toMatchObject({ kind: 'fail', stage: 'input_accepted_stalled' })
    expect(isWorkerDispatchStallVerdict(verdict)).toBe(true)
  })

  it('still fails a turn the agent itself reported dead, whatever the screen shows', () => {
    const verdict = judgeWorkerDispatchStall(
      subject({ updatedAtMs: NOW - 10_000 }),
      {
        state: 'done',
        failed: true,
        failureReason: 'out of usage credits',
        updatedAt: NOW - 1_000
      },
      NOW,
      'waiting'
    )
    expect(verdict).toMatchObject({ kind: 'fail', stage: 'input_accepted_agent_failed' })
    // Only a verdict that came from silence may be held back by the screen.
    expect(isWorkerDispatchStallVerdict(verdict)).toBe(false)
  })
})

describe('judgeWorkerDispatchStall — heartbeats and restarts', () => {
  // The recorded failure: ctx_20403a38f5c7 (timeout 60s) was failed at 18:00:17Z by the first
  // sweep of a runtime that started at 18:00:16Z. Its worker was mid-turn and had heartbeated at
  // 17:59:14Z.
  const RESTART = Date.parse('2026-09-22T18:00:16.874Z')
  const HEARTBEAT = Date.parse('2026-09-22T17:59:14Z')
  const ACCEPTED = Date.parse('2026-09-22T17:57:05Z')

  it('keeps a live worker that the first sweep after a restart cannot observe yet', () => {
    const verdict = judgeWorkerDispatchStall(
      {
        dispatchId: 'ctx_20403a38f5c7',
        stage: 'input_accepted',
        updatedAtMs: ACCEPTED,
        timeoutMs: 60_000,
        heartbeatAtMs: HEARTBEAT,
        observedSinceMs: RESTART
      },
      null,
      RESTART + 1_000
    )
    expect(verdict).toEqual({ kind: 'keep' })
  })

  it('keeps a worker whose heartbeat is inside the budget, however old its dispatch row is', () => {
    expect(
      judgeWorkerDispatchStall(
        { ...subject({ updatedAtMs: NOW - 60 * 60_000 }), heartbeatAtMs: NOW - 30_000 },
        null,
        NOW
      )
    ).toEqual({ kind: 'keep' })
  })

  it('judges a heartbeating worker by the heartbeat contract, not the readiness budget', () => {
    const base = subject({ updatedAtMs: NOW - 60 * 60_000, timeoutMs: 60_000 })
    // Four minutes since its last heartbeat: well past 60s, inside the five-minute contract.
    expect(
      judgeWorkerDispatchStall({ ...base, heartbeatAtMs: NOW - 4 * 60_000 }, null, NOW)
    ).toEqual({ kind: 'keep' })
    const silent = judgeWorkerDispatchStall(
      { ...base, heartbeatAtMs: NOW - HEARTBEAT_PROTOCOL_SILENCE_MS - 1_000 },
      null,
      NOW
    )
    expect(silent.kind).toBe('fail')
    expect(silent.kind === 'fail' && silent.reason).toContain('600s')
  })

  it('keeps the readiness budget for a worker that never heartbeated', () => {
    const verdict = judgeWorkerDispatchStall(
      subject({ updatedAtMs: NOW - 61_000, timeoutMs: 60_000 }),
      null,
      NOW
    )
    expect(verdict.kind).toBe('fail')
    expect(verdict.kind === 'fail' && verdict.reason).toContain('60s')
  })

  it('charges a restart no less than the hung threshold, then fails with that budget', () => {
    const base = {
      ...subject({ updatedAtMs: NOW - 60 * 60_000, timeoutMs: 60_000 }),
      observedSinceMs: NOW - HEARTBEAT_PROTOCOL_SILENCE_MS + 1_000
    }
    expect(judgeWorkerDispatchStall(base, null, NOW)).toEqual({ kind: 'keep' })
    const late = judgeWorkerDispatchStall(
      { ...base, observedSinceMs: NOW - HEARTBEAT_PROTOCOL_SILENCE_MS - 1_000 },
      null,
      NOW
    )
    expect(late.kind).toBe('fail')
    expect(late.kind === 'fail' && late.reason).toContain(
      `${HEARTBEAT_PROTOCOL_SILENCE_MS / 1000}s`
    )
  })

  it('uses the readiness budget once this runtime has seen the dispatch move itself', () => {
    const verdict = judgeWorkerDispatchStall(
      {
        ...subject({ updatedAtMs: NOW - 61_000, timeoutMs: 60_000 }),
        observedSinceMs: NOW - 120_000
      },
      null,
      NOW
    )
    expect(verdict.kind).toBe('fail')
    expect(verdict.kind === 'fail' && verdict.reason).toContain('60s')
  })
})
