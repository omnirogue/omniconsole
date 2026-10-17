/**
 * The host's ONE input queue per agent session.
 *
 * Every write path — chat composer, chain step launch, orchestration worker —
 * enters here, so there is a single ordering domain per session instead of three
 * that cannot see each other. Guarantees:
 *
 *  - FIFO per session, strictly serialized: two items never interleave bytes.
 *  - Atomic items: clear, body and submit belong to one queued item, so no
 *    caller-side timer survives to fire at a target that changed owner.
 *  - Idempotent: a repeat of a delivered `clientMessageId` inside the TTL reports
 *    already-delivered and writes nothing; an identical body from the same origin
 *    inside the duplicate window is refused unless the caller forces it.
 *  - Cancel on rebind: every queued and in-flight item for the old target is
 *    cancelled and reported cancelled, and its writer is dead — zero further bytes.
 *  - Receipts: delivered / already-delivered / duplicate-rejected / cancelled /
 *    failed (carrying the original failure classification).
 */

import {
  isSessionInputDeliveredStatus,
  rejectSessionInputProgram,
  type SessionInputCancelReason,
  type SessionInputOrigin,
  type SessionInputReceipt,
  type SessionInputSubmission
} from '../../../shared/session-input-program'
import {
  SessionInputCancelledError,
  type SessionInputDeliveryContext
} from './session-input-delivery-context'
import { SessionInputIdempotencyLedger } from './session-input-idempotency'
import {
  cancelSessionInputItem,
  createSessionInputItem,
  executeSessionInputItem,
  type SessionInputByteWriter,
  type SessionInputItem,
  type SessionInputItemOutcome
} from './session-input-item'
import { runSessionInputProgram } from './session-input-program-runner'

export type SessionInputQueueDeps = {
  /** Host byte writer. False means the PTY refused the bytes. */
  write: SessionInputByteWriter
  now?: () => number
  idempotencyTtlMs?: number
  duplicateBodyWindowMs?: number
}

export type SessionInputRunRequest = {
  ptyId: string
  origin: SessionInputOrigin
  clientMessageId?: string
  /** Supplying a body opts this caller into the identical-body window. */
  body?: string
  force?: boolean
}

type SessionState = {
  tail: Promise<void>
  items: Set<SessionInputItem>
  pendingById: Map<string, Promise<SessionInputReceipt>>
}

let nextGeneratedMessageId = 1

export class SessionInputQueue {
  private readonly sessions = new Map<string, SessionState>()
  private readonly ledger: SessionInputIdempotencyLedger
  private readonly deps: SessionInputQueueDeps

  constructor(deps: SessionInputQueueDeps) {
    this.deps = deps
    this.ledger = new SessionInputIdempotencyLedger({
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.idempotencyTtlMs !== undefined ? { ttlMs: deps.idempotencyTtlMs } : {}),
      ...(deps.duplicateBodyWindowMs !== undefined
        ? { duplicateBodyWindowMs: deps.duplicateBodyWindowMs }
        : {})
    })
  }

  /** Submit one atomic program. Always resolves with a receipt. */
  submit(submission: SessionInputSubmission): Promise<SessionInputReceipt> {
    const rejection = rejectSessionInputProgram(submission.program)
    if (rejection) {
      return Promise.resolve({
        clientMessageId: submission.clientMessageId,
        status: 'failed',
        errorCode: rejection
      })
    }
    return this.admit(
      {
        ptyId: submission.ptyId,
        origin: submission.origin,
        clientMessageId: submission.clientMessageId,
        body: submission.body,
        ...(submission.force !== undefined ? { force: submission.force } : {})
      },
      (ctx) => runSessionInputProgram(submission.program, ctx),
      () => this.submit(submission)
    ).then((outcome) => outcome.receipt)
  }

  /**
   * Take the session's turn for a delivery the host performs itself (the
   * orchestration worker path). Rejects with the delivery's own error so an
   * existing classification such as `agent_prompt_stalled` reaches its caller
   * unchanged, and with `session_input_cancelled` when the session rebinds.
   */
  runExclusive<T>(
    request: SessionInputRunRequest,
    deliver: (ctx: SessionInputDeliveryContext) => Promise<T>
  ): Promise<T> {
    return this.runExclusiveWithReceipt(request, deliver).then((outcome) => outcome.value as T)
  }

  /**
   * `runExclusive` plus the receipt, so a caller can tell a fresh delivery from a
   * replayed `clientMessageId` — the replay ran no delivery and wrote no bytes.
   */
  runExclusiveWithReceipt<T>(
    request: SessionInputRunRequest,
    deliver: (ctx: SessionInputDeliveryContext) => Promise<T>
  ): Promise<{ receipt: SessionInputReceipt; value?: T }> {
    return this.admit(request, deliver, null).then((outcome) => {
      if (outcome.receipt.status === 'cancelled') {
        throw new SessionInputCancelledError(outcome.receipt.reason ?? 'caller-cancelled')
      }
      if (outcome.error !== undefined) {
        throw outcome.error
      }
      return outcome.value === undefined
        ? { receipt: outcome.receipt }
        : { receipt: outcome.receipt, value: outcome.value }
    })
  }

  /** Cancel every queued and in-flight item for a session; no further byte lands. */
  cancelSession(ptyId: string, reason: SessionInputCancelReason): void {
    // Why: a respawn under the same id is a new session — inherited idempotency
    // would answer the new process's first prompt with the old one's receipt.
    this.ledger.forgetSession(ptyId)
    this.cancelSessionItems(ptyId, {}, reason)
  }

  /**
   * Cancel the session's items that match. An empty filter matches all of them;
   * a caller that only owns its own origin (a chat model switch taking the line)
   * must not cancel a chain step's or a worker's item.
   */
  cancelSessionItems(
    ptyId: string,
    filter: { clientMessageId?: string; origin?: SessionInputOrigin },
    reason: SessionInputCancelReason
  ): number {
    const state = this.sessions.get(ptyId)
    if (!state) {
      return 0
    }
    let cancelled = 0
    for (const item of state.items) {
      if (filter.clientMessageId !== undefined && item.clientMessageId !== filter.clientMessageId) {
        continue
      }
      if (filter.origin !== undefined && item.origin !== filter.origin) {
        continue
      }
      if (!cancelSessionInputItem(item, reason)) {
        continue
      }
      state.items.delete(item)
      cancelled += 1
      // Why: an item that never landed must not hold the duplicate window shut
      // against the same text being sent again on purpose.
      if (item.body !== undefined) {
        this.ledger.releaseBody(ptyId, item.origin, item.body, item.clientMessageId)
      }
    }
    return cancelled
  }

  isIdle(ptyId: string): boolean {
    const state = this.sessions.get(ptyId)
    return !state || state.items.size === 0
  }

  async waitForIdle(ptyId: string): Promise<void> {
    const state = this.sessions.get(ptyId)
    if (!state) {
      return
    }
    await state.tail.catch(() => undefined)
  }

  private admit<T>(
    request: SessionInputRunRequest,
    deliver: (ctx: SessionInputDeliveryContext) => Promise<T>,
    retryAfterJoin: (() => Promise<SessionInputReceipt>) | null
  ): Promise<SessionInputItemOutcome<T>> {
    const clientMessageId = request.clientMessageId ?? `session-input-${nextGeneratedMessageId++}`
    const state = this.getOrCreateSession(request.ptyId)

    const replay = this.ledger.lookupDelivered(request.ptyId, clientMessageId)
    if (replay) {
      return Promise.resolve({ receipt: replay })
    }
    const joined = this.joinInFlight<T>(state, clientMessageId, retryAfterJoin)
    if (joined) {
      return joined
    }
    const duplicate = this.rejectDuplicateBody(request, clientMessageId)
    if (duplicate) {
      return Promise.resolve({ receipt: duplicate })
    }

    const item = createSessionInputItem({
      clientMessageId,
      origin: request.origin,
      ptyId: request.ptyId,
      ...(request.body !== undefined ? { body: request.body } : {})
    })
    state.items.add(item)
    const run = state.tail.then(
      () => this.runItem(state, item, deliver),
      () => this.runItem(state, item, deliver)
    )
    state.tail = run.then(
      () => undefined,
      () => undefined
    )
    state.pendingById.set(
      clientMessageId,
      run.then((outcome) => outcome.receipt)
    )
    return run.then((outcome) => {
      if (state.pendingById.get(clientMessageId)) {
        state.pendingById.delete(clientMessageId)
      }
      return outcome
    })
  }

  private runItem<T>(
    state: SessionState,
    item: SessionInputItem,
    deliver: (ctx: SessionInputDeliveryContext) => Promise<T>
  ): Promise<SessionInputItemOutcome<T>> {
    return executeSessionInputItem(item, deliver, {
      write: this.deps.write,
      onDelivered: (delivered, receipt) => this.ledger.recordDelivered(delivered.ptyId, receipt)
    }).then((outcome) => {
      state.items.delete(item)
      return outcome
    })
  }

  private joinInFlight<T>(
    state: SessionState,
    clientMessageId: string,
    retryAfterJoin: (() => Promise<SessionInputReceipt>) | null
  ): Promise<SessionInputItemOutcome<T>> | null {
    const inFlight = state.pendingById.get(clientMessageId)
    if (!inFlight) {
      return null
    }
    return inFlight.then(async (receipt): Promise<SessionInputItemOutcome<T>> => {
      if (isSessionInputDeliveredStatus(receipt.status)) {
        return { receipt: { ...receipt, status: 'already-delivered' as const } }
      }
      // Why: the joined attempt did not land, so a repeat is a real retry.
      return retryAfterJoin
        ? { receipt: await retryAfterJoin() }
        : { receipt: { ...receipt, clientMessageId } }
    })
  }

  private rejectDuplicateBody(
    request: SessionInputRunRequest,
    clientMessageId: string
  ): SessionInputReceipt | null {
    if (request.body === undefined) {
      return null
    }
    if (
      request.force !== true &&
      this.ledger.isDuplicateBody(request.ptyId, request.origin, request.body, clientMessageId)
    ) {
      return {
        clientMessageId,
        status: 'duplicate-rejected',
        errorCode: 'session_input_duplicate_body'
      }
    }
    this.ledger.recordBody(request.ptyId, request.origin, request.body, clientMessageId)
    return null
  }

  private getOrCreateSession(ptyId: string): SessionState {
    let state = this.sessions.get(ptyId)
    if (!state) {
      state = { tail: Promise.resolve(), items: new Set(), pendingById: new Map() }
      this.sessions.set(ptyId, state)
    }
    return state
  }
}
