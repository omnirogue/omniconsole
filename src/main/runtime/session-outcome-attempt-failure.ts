import { randomUUID } from 'node:crypto'
import { classifyAgentTurnFailure } from '../../shared/agent-turn-failure'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-terminal-contracts'
import {
  sessionAttemptFailureSchema,
  type SessionAttemptFailure,
  type SessionAttemptFailureCode
} from '../../shared/session-attempt-recovery'
import { SESSION_OUTCOME_BRIEF_TOO_LARGE } from '../../shared/session-outcome-recovery-reason'
import {
  sessionOutcomeActionKey,
  type SessionOutcome,
  type SessionOutcomeAction,
  type SessionOutcomeAttempt
} from '../../shared/session-outcome-types'

/**
 * WHY an attempt stopped, read from structure: the worker dispatch's stage, the dispatch's recorded
 * termination cause, the launch disposition. The recovery ladder reads the code; `attempt.error`
 * stays the diagnostic prose and is never parsed for a decision
 * (`docs/reference/session-run-lifecycle.md`).
 */

/** The assembled brief is past the worker limit: only a shorter stage can pass, never a retry. */
export class SessionOutcomeBriefTooLargeError extends Error {}

// A record keyed by the union, so a blocker id added to the runtime contract fails to compile here.
const STARTUP_BLOCKER_IDS: Record<RuntimeTerminalWaitBlockedReason, true> = {
  'codex-update-prompt': true,
  'codex-trust-workspace': true,
  'codex-cwd-prompt': true,
  'codex-model-migration-prompt': true,
  'codex-hooks-review-prompt': true,
  'codex-interactive-prompt': true,
  'agent-approval-prompt': true
}

/** Submission verdicts the prompt door reports as machine ids (`rpc/errors.ts`). */
const PROMPT_SUBMISSION_IDS = ['agent_prompt_blocked', 'agent_prompt_stalled'] as const

/** The worker dispatch row fields a failure is read from. */
export type SessionAttemptWorkerRow = {
  stage: string
  last_error: string | null
  /** The readiness wait's blocker id, recorded beside the sentence people read. */
  startup_blocker?: string | null
}

/**
 * The startup blocker a failed readiness wait named: the row's own `startup_blocker` column, and
 * for rows written before that column existed the id inside `Agent startup blocked: <id>`. Either
 * way it is matched against the runtime's closed set: a machine id, never a keyword search of prose.
 */
export function sessionAttemptStartupBlocker(
  worker: Pick<SessionAttemptWorkerRow, 'last_error' | 'startup_blocker'> | undefined
): RuntimeTerminalWaitBlockedReason | undefined {
  const id =
    worker?.startup_blocker ??
    /^Agent startup blocked: ([a-z-]+)$/.exec(worker?.last_error?.trim() ?? '')?.[1]
  // `hasOwn`, not `in`: a stored string such as `constructor` must not pass for a blocker id.
  return id && Object.hasOwn(STARTUP_BLOCKER_IDS, id)
    ? (id as RuntimeTerminalWaitBlockedReason)
    : undefined
}

export function sessionAttemptFailure(
  code: SessionAttemptFailureCode,
  now: number,
  detail?: string | null
): SessionAttemptFailure {
  const failure = { code, at: now, ...(detail ? { detail } : {}) }
  // A detail the schema cannot hold would cost the whole set its write; the code alone is enough.
  return sessionAttemptFailureSchema.safeParse(failure).success ? failure : { code, at: now }
}

/** The failure a settled worker dispatch proves, from its stage and recorded termination cause. */
export function workerDispatchFailure(
  worker: SessionAttemptWorkerRow | undefined,
  dispatch: { termination_reason?: string | null },
  now: number
): SessionAttemptFailure {
  const stage = worker?.stage ?? ''
  if (stage.endsWith('_agent_failed')) {
    const kind = classifyAgentTurnFailure(worker?.last_error ?? undefined)
    return sessionAttemptFailure(
      kind === 'usage-limit'
        ? 'provider-usage-limit'
        : kind === 'authentication'
          ? 'provider-authentication'
          : 'agent-turn-failed',
      now,
      stage
    )
  }
  if (stage.endsWith('_stalled')) {
    return sessionAttemptFailure('worker-stalled', now, stage)
  }
  if (stage === 'process_exited') {
    return sessionAttemptFailure(
      dispatch.termination_reason === 'operator_close' ? 'operator-closed' : 'worker-exited',
      now,
      dispatch.termination_reason
    )
  }
  if (stage === 'agent_readiness') {
    return sessionAttemptFailure('startup-blocked', now, sessionAttemptStartupBlocker(worker))
  }
  if (stage === 'dispatch_input' || stage.startsWith('agent_prompt_')) {
    const verdict = PROMPT_SUBMISSION_IDS.find((id) => worker?.last_error?.trim() === id)
    return sessionAttemptFailure('prompt-not-accepted', now, verdict ?? stage)
  }
  // `settled` is the worker's own failed report: its turn ended without the work.
  return sessionAttemptFailure(stage === 'settled' ? 'agent-turn-failed' : 'unknown', now, stage)
}

// A settled dispatch row proves the host gave up on a worker, not that its process exited: the
// stall watchdog only writes rows, and a prompt whose submission went unverified may have landed.
const MAY_STILL_RUN: ReadonlySet<SessionAttemptFailureCode> = new Set([
  'worker-stalled',
  'prompt-not-accepted',
  'unknown'
])

/** Whether the old worker must be stopped, and the stop confirmed, before a replacement starts. */
export function sessionAttemptWorkerMayStillRun(code: SessionAttemptFailureCode): boolean {
  return MAY_STILL_RUN.has(code)
}

/** A launch that never produced a worker: nothing ran, so nothing can be duplicated. */
export function launchNotStartedFailure(error: unknown, now: number): SessionAttemptFailure {
  return sessionAttemptFailure(
    error instanceof SessionOutcomeBriefTooLargeError ? 'brief-too-large' : 'launch-not-started',
    now
  )
}

/**
 * The record of a launch the host refused before anything was dispatched, so the plan shows WHICH
 * action could not be briefed. Retrying duplicates nothing — but only a shorter brief can pass an
 * oversized one, which is why that refusal carries its own code and is never retried as it is.
 */
export function refusedSessionOutcomeAttempt(input: {
  outcome: Pick<SessionOutcome, 'id' | 'revision'>
  planVersion: number | undefined
  actionId: string
  action: SessionOutcomeAction | undefined
  error: unknown
  now?: number
}): SessionOutcomeAttempt {
  const now = input.now ?? Date.now()
  // Never blank: the set's schema refuses an empty error, and that would cost the whole write.
  const reason =
    (input.error instanceof Error ? input.error.message : String(input.error)).trim() ||
    'The launch could not be staged.'
  return {
    id: randomUUID(),
    outcomeId: input.outcome.id,
    actionId: input.actionId,
    actionKey: input.action
      ? sessionOutcomeActionKey(input.action)
      : JSON.stringify([input.actionId, 'unprepared']),
    outcomeRevision: input.outcome.revision,
    ...(input.planVersion ? { planVersion: input.planVersion } : {}),
    state: 'blocked',
    launchDisposition: 'not-started',
    error:
      input.error instanceof SessionOutcomeBriefTooLargeError
        ? `${SESSION_OUTCOME_BRIEF_TOO_LARGE}: ${reason}`
        : reason,
    failure: launchNotStartedFailure(input.error, now),
    startedAt: now,
    updatedAt: now
  }
}

/** Attempts of the same action at the same outcome revision and plan version. */
export function sameRecoveryLineage(
  left: Pick<SessionOutcomeAttempt, 'outcomeId' | 'actionId' | 'outcomeRevision' | 'planVersion'>,
  right: Pick<SessionOutcomeAttempt, 'outcomeId' | 'actionId' | 'outcomeRevision' | 'planVersion'>
): boolean {
  return (
    left.outcomeId === right.outcomeId &&
    left.actionId === right.actionId &&
    left.outcomeRevision === right.outcomeRevision &&
    (left.planVersion ?? 1) === (right.planVersion ?? 1)
  )
}
