import { z } from 'zod'
import type { SessionFinishChoice } from './session-finish-intent'

/**
 * The seal on a run whose required work is proven, and the separate record of what happens to the
 * session afterwards. Success is decided once and stays decided; closing or saving the session is
 * an operation of its own that may fail and be retried without touching the success
 * (`docs/reference/session-run-lifecycle.md`).
 */
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const at = z.number().finite().nonnegative()

export const sessionRunCompletionSchema = z
  .object({
    at,
    /** The outcome revisions that were proven: a later edit is a new run, not a change to this one. */
    outcomes: z.array(z.object({ id, revision: z.number().int().positive() }).strict()).min(1),
    planVersion: z.number().int().positive().optional(),
    evidenceIds: z.array(id)
  })
  .strict()
export type SessionRunCompletion = z.infer<typeof sessionRunCompletionSchema>

export const SESSION_RUN_DISPOSITION_INTENTS = ['completed', 'close', 'save'] as const
export type SessionRunDispositionIntent = (typeof SESSION_RUN_DISPOSITION_INTENTS)[number]

export const sessionRunDispositionSchema = z
  .object({
    intent: z.enum(SESSION_RUN_DISPOSITION_INTENTS),
    folderId: z.string().min(1).max(200).optional(),
    state: z.enum(['pending', 'applied', 'failed']),
    /** Names this one operation: a result reported under another id is about something else. */
    operationId: id,
    attempts: z.number().int().nonnegative(),
    lastError: z.string().trim().min(1).max(1_000).optional(),
    nextAttemptAt: at.optional(),
    appliedAt: at.optional(),
    updatedAt: at
  })
  .strict()
export type SessionRunDisposition = z.infer<typeof sessionRunDispositionSchema>

export const SESSION_DISPOSITION_MAX_ATTEMPTS = 5
export const SESSION_DISPOSITION_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000] as const

/**
 * Without an explicit terminal action a finished session goes to Completed and nothing is closed;
 * `me` is the legacy way of saying the same thing.
 */
export function sessionRunDispositionIntent(finish: SessionFinishChoice | undefined): {
  intent: SessionRunDispositionIntent
  folderId?: string
} {
  if (finish?.action === 'end') {
    return { intent: 'close' }
  }
  if (finish?.action === 'save') {
    return { intent: 'save', ...(finish.folderId ? { folderId: finish.folderId } : {}) }
  }
  return { intent: 'completed' }
}

type SealableSet = {
  sessionFinish?: SessionFinishChoice
  completion?: SessionRunCompletion
  disposition?: SessionRunDisposition
  outcomes: readonly { id: string; revision: number; evidence: readonly { id: string }[] }[]
}

/**
 * Seal a proven run, once. The caller has already established that every required stage and
 * condition is proven; sealing a second time changes nothing, which is what makes a duplicate or
 * late completion harmless.
 */
export function sealSessionRunCompletion<T extends SealableSet>(
  set: T,
  input: { now: number; operationId: string; planVersion?: number }
): T {
  if (set.completion) {
    return set
  }
  const { intent, folderId } = sessionRunDispositionIntent(set.sessionFinish)
  const applied = intent === 'completed'
  return {
    ...set,
    completion: {
      at: input.now,
      outcomes: set.outcomes.map((outcome) => ({ id: outcome.id, revision: outcome.revision })),
      ...(input.planVersion ? { planVersion: input.planVersion } : {}),
      evidenceIds: set.outcomes.flatMap((outcome) => outcome.evidence.map((entry) => entry.id))
    },
    disposition: {
      intent,
      ...(folderId ? { folderId } : {}),
      // Completed asks nothing of any window, so it is applied by being recorded.
      state: applied ? 'applied' : 'pending',
      operationId: input.operationId,
      attempts: 0,
      ...(applied ? { appliedAt: input.now } : {}),
      updatedAt: input.now
    }
  }
}

/** The disposition a window should perform now, if any. */
export function dueSessionRunDisposition(
  set: Pick<SealableSet, 'completion' | 'disposition'>,
  now: number
): SessionRunDisposition | null {
  const disposition = set.disposition
  if (!set.completion || !disposition || disposition.state !== 'pending') {
    return null
  }
  return (disposition.nextAttemptAt ?? 0) <= now ? disposition : null
}

export type SessionRunDispositionReport = { operationId: string; ok: boolean; error?: string }

/**
 * Record what a window reported. Idempotent per operation: a second `ok` changes nothing, a report
 * under another operation id is ignored, and nothing here can reach the completion seal.
 */
export function recordSessionRunDisposition<T extends SealableSet>(
  set: T,
  report: SessionRunDispositionReport,
  now: number
): T {
  const disposition = set.disposition
  if (
    !set.completion ||
    !disposition ||
    disposition.operationId !== report.operationId ||
    disposition.state === 'applied'
  ) {
    return set
  }
  if (report.ok) {
    const { lastError: _cleared, nextAttemptAt: _done, ...rest } = disposition
    return { ...set, disposition: { ...rest, state: 'applied', appliedAt: now, updatedAt: now } }
  }
  const attempts = disposition.attempts + 1
  const exhausted = attempts >= SESSION_DISPOSITION_MAX_ATTEMPTS
  const { nextAttemptAt: _previous, ...rest } = disposition
  return {
    ...set,
    disposition: {
      ...rest,
      attempts,
      state: exhausted ? 'failed' : 'pending',
      lastError: (report.error?.trim() || 'The session could not be closed or saved.').slice(
        0,
        1_000
      ),
      ...(exhausted
        ? {}
        : {
            nextAttemptAt:
              now +
              SESSION_DISPOSITION_BACKOFF_MS[
                Math.min(attempts - 1, SESSION_DISPOSITION_BACKOFF_MS.length - 1)
              ]!
          }),
      updatedAt: now
    }
  }
}

/** A person asking again after the bounded retries ran out: one more bounded series, same operation. */
export function retrySessionRunDisposition<T extends SealableSet>(set: T, now: number): T {
  const disposition = set.disposition
  if (!set.completion || !disposition || disposition.state !== 'failed') {
    return set
  }
  return { ...set, disposition: { ...disposition, state: 'pending', attempts: 0, updatedAt: now } }
}
