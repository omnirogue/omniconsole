import { describe, expect, it } from 'vitest'
import { describeAgentTurnFailure } from '../../shared/agent-turn-failure'
import {
  launchNotStartedFailure,
  refusedSessionOutcomeAttempt,
  sameRecoveryLineage,
  SessionOutcomeBriefTooLargeError,
  sessionAttemptFailure,
  sessionAttemptStartupBlocker,
  workerDispatchFailure
} from './session-outcome-attempt-failure'

const NOW = 5_000

// The three failures in the record this fixes, exactly as the orchestration rows carry them.
const STALL_TEXT =
  "No activity was observed for 180s after this step's instruction was accepted, so the step is not running. Open that conversation to see what happened, then run the step again."
const QUOTA_WALL = "You're out of usage credits. Run /usage-credits to keep using this model."

describe('the failure code a settled worker dispatch proves', () => {
  it.each([
    [
      'the 180 s stall watchdog',
      { stage: 'input_accepted_stalled', last_error: STALL_TEXT },
      {},
      { code: 'worker-stalled', detail: 'input_accepted_stalled' }
    ],
    [
      'a process that exited',
      { stage: 'process_exited', last_error: 'Agent process exited with code 1' },
      { termination_reason: 'exited' },
      { code: 'worker-exited', detail: 'exited' }
    ],
    [
      'a process killed by a signal',
      { stage: 'process_exited', last_error: 'Agent process killed by signal 9' },
      { termination_reason: 'signaled' },
      { code: 'worker-exited', detail: 'signaled' }
    ],
    [
      'a terminal the person closed',
      { stage: 'process_exited', last_error: 'Terminal closed by operator request' },
      { termination_reason: 'operator_close' },
      { code: 'operator-closed', detail: 'operator_close' }
    ],
    [
      'a startup blocker',
      { stage: 'agent_readiness', last_error: 'Agent startup blocked: codex-hooks-review-prompt' },
      {},
      { code: 'startup-blocked', detail: 'codex-hooks-review-prompt' }
    ],
    [
      'an agent that never became ready',
      { stage: 'agent_readiness', last_error: 'Agent did not become ready (running).' },
      {},
      { code: 'startup-blocked' }
    ],
    [
      'a prompt the agent did not accept',
      { stage: 'dispatch_input', last_error: 'agent_prompt_stalled' },
      {},
      { code: 'prompt-not-accepted', detail: 'agent_prompt_stalled' }
    ],
    [
      'a provider usage wall',
      { stage: 'input_accepted_agent_failed', last_error: describeAgentTurnFailure(QUOTA_WALL) },
      {},
      { code: 'provider-usage-limit', detail: 'input_accepted_agent_failed' }
    ],
    [
      'a rejected sign-in',
      {
        stage: 'input_accepted_agent_failed',
        last_error: describeAgentTurnFailure('Invalid API key · Please run /login')
      },
      {},
      { code: 'provider-authentication', detail: 'input_accepted_agent_failed' }
    ],
    [
      'a turn that died without a recognised cause',
      { stage: 'input_accepted_agent_failed', last_error: describeAgentTurnFailure(undefined) },
      {},
      { code: 'agent-turn-failed', detail: 'input_accepted_agent_failed' }
    ],
    [
      "the worker's own failed report",
      { stage: 'settled', last_error: null },
      {},
      { code: 'agent-turn-failed', detail: 'settled' }
    ],
    [
      'a stage nobody classified',
      { stage: 'terminal_missing', last_error: 'gone' },
      {},
      { code: 'unknown', detail: 'terminal_missing' }
    ]
  ])('reads %s from the row, not from its prose', (_name, worker, dispatch, expected) => {
    expect(workerDispatchFailure(worker, dispatch, NOW)).toEqual({ at: NOW, ...expected })
  })

  it('never takes an operator close from the words of an error', () => {
    expect(
      workerDispatchFailure(
        { stage: 'input_accepted_stalled', last_error: 'Terminal closed by operator request' },
        {},
        NOW
      ).code
    ).toBe('worker-stalled')
  })

  it('falls back to a bare code when there is no worker row at all', () => {
    expect(workerDispatchFailure(undefined, {}, NOW)).toEqual({ code: 'unknown', at: NOW })
  })
})

describe('startup blocker ids', () => {
  const written = (lastError: string | null, blocker?: string | null) => ({
    last_error: lastError,
    ...(blocker === undefined ? {} : { startup_blocker: blocker })
  })

  it('reads the id the row recorded beside its sentence', () => {
    expect(
      sessionAttemptStartupBlocker(
        written('Agent startup blocked: codex-trust-workspace', 'codex-trust-workspace')
      )
    ).toBe('codex-trust-workspace')
    // The column is the source: the sentence people read may say anything.
    expect(
      sessionAttemptStartupBlocker(written('Codex asked to trust this folder.', 'codex-cwd-prompt'))
    ).toBe('codex-cwd-prompt')
    expect(
      workerDispatchFailure(
        {
          stage: 'agent_readiness',
          last_error: 'Agent startup blocked: codex-update-prompt',
          startup_blocker: 'codex-update-prompt'
        },
        {},
        NOW
      )
    ).toEqual({ code: 'startup-blocked', detail: 'codex-update-prompt', at: NOW })
  })

  it('accepts only the closed set of runtime blocker ids', () => {
    expect(sessionAttemptStartupBlocker(written(null, 'something-else'))).toBeUndefined()
    expect(sessionAttemptStartupBlocker(written(null, 'constructor'))).toBeUndefined()
    expect(sessionAttemptStartupBlocker(written(null, null))).toBeUndefined()
    expect(sessionAttemptStartupBlocker(undefined)).toBeUndefined()
  })

  it('falls back to the sentence only for rows written before the column existed', () => {
    expect(
      sessionAttemptStartupBlocker(written('Agent startup blocked: codex-trust-workspace'))
    ).toBe('codex-trust-workspace')
    expect(
      sessionAttemptStartupBlocker(written('Agent startup blocked: something-else'))
    ).toBeUndefined()
    expect(
      sessionAttemptStartupBlocker(written('Agent startup blocked: constructor'))
    ).toBeUndefined()
    expect(
      sessionAttemptStartupBlocker(written('The agent mentioned codex-trust-workspace in passing.'))
    ).toBeUndefined()
    expect(sessionAttemptStartupBlocker(written(null))).toBeUndefined()
  })

  it('drops a detail the set schema could not hold instead of failing the write', () => {
    expect(sessionAttemptFailure('unknown', NOW, 'not a machine id!')).toEqual({
      code: 'unknown',
      at: NOW
    })
  })
})

describe('a launch the host refused before anything was dispatched', () => {
  const outcome = { id: 'ship', revision: 3 }

  it('carries brief-too-large only for the typed refusal', () => {
    expect(
      launchNotStartedFailure(new SessionOutcomeBriefTooLargeError('too long'), NOW).code
    ).toBe('brief-too-large')
    expect(launchNotStartedFailure(new Error('too long'), NOW).code).toBe('launch-not-started')
  })

  it('records the refusal as a not-started attempt at the current revision and plan version', () => {
    const refused = refusedSessionOutcomeAttempt({
      outcome,
      planVersion: 2,
      actionId: 'step_build',
      action: undefined,
      error: new SessionOutcomeBriefTooLargeError('120,000 characters'),
      now: NOW
    })
    expect(refused).toMatchObject({
      outcomeId: 'ship',
      actionId: 'step_build',
      outcomeRevision: 3,
      planVersion: 2,
      state: 'blocked',
      launchDisposition: 'not-started',
      error: 'brief-too-large: 120,000 characters',
      failure: { code: 'brief-too-large', at: NOW },
      startedAt: NOW,
      updatedAt: NOW
    })
  })
})

describe('the lineage a retry budget is counted over', () => {
  const base = { outcomeId: 'ship', actionId: 'step_a', outcomeRevision: 1 }

  it('is one action at one outcome revision and one plan version', () => {
    expect(sameRecoveryLineage(base, { ...base, planVersion: 1 })).toBe(true)
    expect(sameRecoveryLineage(base, { ...base, planVersion: 2 })).toBe(false)
    expect(sameRecoveryLineage(base, { ...base, outcomeRevision: 2 })).toBe(false)
    expect(sameRecoveryLineage(base, { ...base, actionId: 'step_b' })).toBe(false)
  })
})
