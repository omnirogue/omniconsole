import { describe, expect, it } from 'vitest'
import type { SessionFinishChoice } from './session-finish-intent'
import {
  SESSION_DISPOSITION_BACKOFF_MS,
  SESSION_DISPOSITION_MAX_ATTEMPTS,
  dueSessionRunDisposition,
  recordSessionRunDisposition,
  retrySessionRunDisposition,
  sealSessionRunCompletion,
  sessionRunCompletionSchema,
  sessionRunDispositionIntent,
  sessionRunDispositionSchema,
  type SessionRunCompletion,
  type SessionRunDisposition
} from './session-run-completion'

type Run = {
  sessionFinish?: SessionFinishChoice
  completion?: SessionRunCompletion
  disposition?: SessionRunDisposition
  outcomes: { id: string; revision: number; evidence: { id: string }[] }[]
}

const SEALED_AT = 1_000_000
const proven = (sessionFinish?: SessionFinishChoice): Run => ({
  ...(sessionFinish ? { sessionFinish } : {}),
  outcomes: [
    { id: 'one', revision: 2, evidence: [{ id: 'receipt_one' }] },
    { id: 'two', revision: 1, evidence: [{ id: 'receipt_two_a' }, { id: 'receipt_two_b' }] }
  ]
})
const seal = (sessionFinish?: SessionFinishChoice): Run =>
  sealSessionRunCompletion(proven(sessionFinish), { now: SEALED_AT, operationId: 'op_seal' })
const failing = (run: Run, times: number, from = SEALED_AT): Run =>
  Array.from({ length: times }).reduce<Run>(
    (next, _entry, index) =>
      recordSessionRunDisposition(
        next,
        { operationId: 'op_seal', ok: false, error: `close failed ${index + 1}` },
        from + index
      ),
    run
  )

describe('sealing a proven run', () => {
  it('records when, which outcome revisions, and which receipts proved it', () => {
    const sealed = sealSessionRunCompletion(proven(), {
      now: SEALED_AT,
      operationId: 'op_seal',
      planVersion: 3
    })
    expect(sealed.completion).toEqual({
      at: SEALED_AT,
      outcomes: [
        { id: 'one', revision: 2 },
        { id: 'two', revision: 1 }
      ],
      planVersion: 3,
      evidenceIds: ['receipt_one', 'receipt_two_a', 'receipt_two_b']
    })
    expect(sessionRunCompletionSchema.parse(sealed.completion)).toEqual(sealed.completion)
    expect(sessionRunDispositionSchema.parse(sealed.disposition)).toEqual(sealed.disposition)
    expect('planVersion' in seal().completion!).toBe(false)
  })

  it('seals once: a duplicate or late completion changes nothing', () => {
    const sealed = seal({ action: 'end' })
    const again = sealSessionRunCompletion(
      { ...sealed, sessionFinish: { action: 'save', folderId: 'folder_1' } },
      { now: SEALED_AT + 99, operationId: 'op_other', planVersion: 7 }
    )
    expect(again.completion).toBe(sealed.completion)
    expect(again.disposition).toBe(sealed.disposition)
    expect(sealSessionRunCompletion(sealed, { now: SEALED_AT + 99, operationId: 'op_other' })).toBe(
      sealed
    )
  })

  it.each([undefined, { action: 'me' } as const])(
    'goes to Completed, applied at the seal, when no terminal action was chosen (%o)',
    (finish) => {
      expect(sessionRunDispositionIntent(finish)).toEqual({ intent: 'completed' })
      const sealed = seal(finish)
      expect(sealed.disposition).toEqual({
        intent: 'completed',
        state: 'applied',
        operationId: 'op_seal',
        attempts: 0,
        appliedAt: SEALED_AT,
        updatedAt: SEALED_AT
      })
      // Nothing is asked of any window: nothing is closed and nothing is saved.
      expect(dueSessionRunDisposition(sealed, SEALED_AT + 1)).toBeNull()
    }
  )

  it('leaves Close pending for a window to perform', () => {
    expect(sessionRunDispositionIntent({ action: 'end' })).toEqual({ intent: 'close' })
    const sealed = seal({ action: 'end' })
    expect(sealed.disposition).toEqual({
      intent: 'close',
      state: 'pending',
      operationId: 'op_seal',
      attempts: 0,
      updatedAt: SEALED_AT
    })
    expect(dueSessionRunDisposition(sealed, SEALED_AT)).toBe(sealed.disposition)
  })

  it('leaves Save pending, and keeps the folder it was told to save to', () => {
    expect(sessionRunDispositionIntent({ action: 'save', folderId: 'folder_1' })).toEqual({
      intent: 'save',
      folderId: 'folder_1'
    })
    expect(seal({ action: 'save', folderId: 'folder_1' }).disposition).toMatchObject({
      intent: 'save',
      folderId: 'folder_1',
      state: 'pending'
    })
    const unfiled = seal({ action: 'save' }).disposition!
    expect(unfiled.intent).toBe('save')
    expect('folderId' in unfiled).toBe(false)
  })
})

describe('what a window reports about the disposition', () => {
  it('applies on ok, and a second ok is a no-op', () => {
    const sealed = seal({ action: 'end' })
    const retried = failing(sealed, 1)
    const applied = recordSessionRunDisposition(
      retried,
      { operationId: 'op_seal', ok: true },
      SEALED_AT + 50
    )
    expect(applied.disposition).toEqual({
      intent: 'close',
      state: 'applied',
      operationId: 'op_seal',
      attempts: 1,
      appliedAt: SEALED_AT + 50,
      updatedAt: SEALED_AT + 50
    })
    expect(
      recordSessionRunDisposition(applied, { operationId: 'op_seal', ok: true }, SEALED_AT + 90)
    ).toBe(applied)
    // Nor can a late failure un-apply it.
    expect(
      recordSessionRunDisposition(
        applied,
        { operationId: 'op_seal', ok: false, error: 'late' },
        SEALED_AT + 90
      )
    ).toBe(applied)
    expect(dueSessionRunDisposition(applied, SEALED_AT + 99)).toBeNull()
  })

  it('keeps a failure pending with a backoff, and never reports it as applied', () => {
    const failed = failing(seal({ action: 'save', folderId: 'folder_1' }), 1)
    expect(failed.disposition).toEqual({
      intent: 'save',
      folderId: 'folder_1',
      state: 'pending',
      operationId: 'op_seal',
      attempts: 1,
      lastError: 'close failed 1',
      nextAttemptAt: SEALED_AT + SESSION_DISPOSITION_BACKOFF_MS[0],
      updatedAt: SEALED_AT
    })
    expect(failed.disposition?.appliedAt).toBeUndefined()
    expect(sessionRunDispositionSchema.safeParse(failed.disposition).success).toBe(true)
    const next = failed.disposition!.nextAttemptAt!
    expect(dueSessionRunDisposition(failed, next - 1)).toBeNull()
    expect(dueSessionRunDisposition(failed, next)).toBe(failed.disposition)
  })

  it('lengthens the backoff with each failure, then fails at the bound', () => {
    let run = seal({ action: 'end' })
    SESSION_DISPOSITION_BACKOFF_MS.forEach((backoff, index) => {
      const at = SEALED_AT + index * 1_000_000
      run = recordSessionRunDisposition(run, { operationId: 'op_seal', ok: false }, at)
      expect(run.disposition).toMatchObject({
        state: 'pending',
        attempts: index + 1,
        nextAttemptAt: at + backoff,
        lastError: 'The session could not be closed or saved.'
      })
    })
    expect(SESSION_DISPOSITION_BACKOFF_MS).toHaveLength(SESSION_DISPOSITION_MAX_ATTEMPTS - 1)
    const exhausted = recordSessionRunDisposition(
      run,
      { operationId: 'op_seal', ok: false, error: '   ' },
      SEALED_AT + 9_000_000
    )
    expect(exhausted.disposition).toMatchObject({
      state: 'failed',
      attempts: SESSION_DISPOSITION_MAX_ATTEMPTS
    })
    expect('nextAttemptAt' in exhausted.disposition!).toBe(false)
    expect(dueSessionRunDisposition(exhausted, Number.MAX_SAFE_INTEGER)).toBeNull()
    expect(sessionRunDispositionSchema.safeParse(exhausted.disposition).success).toBe(true)
    // A window that succeeds after all is believed: the session IS closed.
    expect(
      recordSessionRunDisposition(exhausted, { operationId: 'op_seal', ok: true }, SEALED_AT)
        .disposition?.state
    ).toBe('applied')
  })

  it('ignores a report made under another operation id, or about an unsealed run', () => {
    const sealed = seal({ action: 'end' })
    expect(recordSessionRunDisposition(sealed, { operationId: 'op_other', ok: true }, 5)).toBe(
      sealed
    )
    expect(recordSessionRunDisposition(sealed, { operationId: 'op_other', ok: false }, 5)).toBe(
      sealed
    )
    const unsealed = proven({ action: 'end' })
    expect(recordSessionRunDisposition(unsealed, { operationId: 'op_seal', ok: true }, 5)).toBe(
      unsealed
    )
    expect(dueSessionRunDisposition(unsealed, 5)).toBeNull()
  })

  it('never touches the completion, whatever happens to the disposition', () => {
    const sealed = seal({ action: 'end' })
    const completion = structuredClone(sealed.completion)
    const exhausted = failing(sealed, SESSION_DISPOSITION_MAX_ATTEMPTS)
    expect(exhausted.disposition?.state).toBe('failed')
    const retried = retrySessionRunDisposition(exhausted, SEALED_AT + 500)
    const applied = recordSessionRunDisposition(
      retried,
      { operationId: 'op_seal', ok: true },
      SEALED_AT + 600
    )
    for (const run of [exhausted, retried, applied]) {
      expect(run.completion).toBe(sealed.completion)
      expect(run.completion).toEqual(completion)
    }
  })

  it('clips an error the schema could not hold', () => {
    const failed = recordSessionRunDisposition(
      seal({ action: 'end' }),
      { operationId: 'op_seal', ok: false, error: 'x'.repeat(5_000) },
      SEALED_AT
    )
    expect(failed.disposition?.lastError).toHaveLength(1_000)
    expect(sessionRunDispositionSchema.safeParse(failed.disposition).success).toBe(true)
  })
})

describe('asking again after the retries ran out', () => {
  it('starts one more bounded series under the same operation, due at once', () => {
    const exhausted = failing(seal({ action: 'end' }), SESSION_DISPOSITION_MAX_ATTEMPTS)
    const retried = retrySessionRunDisposition(exhausted, SEALED_AT + 500)
    expect(retried.disposition).toMatchObject({
      intent: 'close',
      state: 'pending',
      operationId: 'op_seal',
      attempts: 0,
      updatedAt: SEALED_AT + 500
    })
    expect(dueSessionRunDisposition(retried, SEALED_AT + 500)).toBe(retried.disposition)
    expect(failing(retried, SESSION_DISPOSITION_MAX_ATTEMPTS).disposition?.state).toBe('failed')
  })

  it('does nothing to a disposition that has not failed', () => {
    const pending = seal({ action: 'end' })
    expect(retrySessionRunDisposition(pending, 5)).toBe(pending)
    const applied = seal()
    expect(retrySessionRunDisposition(applied, 5)).toBe(applied)
    const unsealed = proven()
    expect(retrySessionRunDisposition(unsealed, 5)).toBe(unsealed)
  })
})
