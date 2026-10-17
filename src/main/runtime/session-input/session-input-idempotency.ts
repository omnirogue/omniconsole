/**
 * What the session input queue remembers so a repeat does not become a second
 * delivery: settled `clientMessageId`s inside a TTL, and the bodies each origin
 * delivered inside the duplicate window.
 *
 * Only a DELIVERED id replays. A failed or cancelled id stays retryable — a
 * worker re-sending after `agent_prompt_stalled` must reach the agent.
 */

import { boundJournalKeyComponent } from '../../../shared/agent-session-journal-item-key'
import {
  SESSION_INPUT_DUPLICATE_BODY_WINDOW_MS,
  SESSION_INPUT_IDEMPOTENCY_TTL_MS,
  type SessionInputOrigin,
  type SessionInputReceipt
} from '../../../shared/session-input-program'

type DeliveredEntry = { receipt: SessionInputReceipt; at: number }

/** Which message claimed a body, so its own retry is never its own duplicate. */
type BodyEntry = { at: number; clientMessageId: string }

export type SessionInputIdempotencyOptions = {
  now?: () => number
  ttlMs?: number
  duplicateBodyWindowMs?: number
}

export class SessionInputIdempotencyLedger {
  private readonly deliveredByKey = new Map<string, DeliveredEntry>()
  private readonly bodyByKey = new Map<string, BodyEntry>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly duplicateBodyWindowMs: number

  constructor(options: SessionInputIdempotencyOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? SESSION_INPUT_IDEMPOTENCY_TTL_MS
    this.duplicateBodyWindowMs =
      options.duplicateBodyWindowMs ?? SESSION_INPUT_DUPLICATE_BODY_WINDOW_MS
  }

  /** The receipt a repeat of `clientMessageId` replays, or null to deliver it. */
  lookupDelivered(sessionKey: string, clientMessageId: string): SessionInputReceipt | null {
    const key = this.messageKey(sessionKey, clientMessageId)
    const entry = this.deliveredByKey.get(key)
    if (!entry) {
      return null
    }
    if (this.now() - entry.at > this.ttlMs) {
      this.deliveredByKey.delete(key)
      return null
    }
    return { ...entry.receipt, status: 'already-delivered' }
  }

  recordDelivered(sessionKey: string, receipt: SessionInputReceipt): void {
    this.prune()
    this.deliveredByKey.set(this.messageKey(sessionKey, receipt.clientMessageId), {
      receipt,
      at: this.now()
    })
  }

  /**
   * True while an identical body from the same origin is inside the window and
   * belongs to a DIFFERENT message. A retry of the same `clientMessageId` is the
   * same message, so its own record never blocks it.
   */
  isDuplicateBody(
    sessionKey: string,
    origin: SessionInputOrigin,
    body: string,
    clientMessageId: string
  ): boolean {
    const key = this.bodyKey(sessionKey, origin, body)
    const entry = this.bodyByKey.get(key)
    if (!entry) {
      return false
    }
    if (this.now() - entry.at > this.duplicateBodyWindowMs) {
      this.bodyByKey.delete(key)
      return false
    }
    return entry.clientMessageId !== clientMessageId
  }

  recordBody(
    sessionKey: string,
    origin: SessionInputOrigin,
    body: string,
    clientMessageId: string
  ): void {
    this.prune()
    this.bodyByKey.set(this.bodyKey(sessionKey, origin, body), { at: this.now(), clientMessageId })
  }

  /**
   * Release a body claim whose item never landed, so retyping the same text right
   * after a cancel is not refused as that cancelled item's duplicate.
   */
  releaseBody(
    sessionKey: string,
    origin: SessionInputOrigin,
    body: string,
    clientMessageId: string
  ): void {
    const key = this.bodyKey(sessionKey, origin, body)
    if (this.bodyByKey.get(key)?.clientMessageId === clientMessageId) {
      this.bodyByKey.delete(key)
    }
  }

  /** Drop everything for a session whose PTY is gone. */
  forgetSession(sessionKey: string): void {
    const prefix = `${sessionKey}\u0000`
    for (const key of this.deliveredByKey.keys()) {
      if (key.startsWith(prefix)) {
        this.deliveredByKey.delete(key)
      }
    }
    for (const key of this.bodyByKey.keys()) {
      if (key.startsWith(prefix)) {
        this.bodyByKey.delete(key)
      }
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [key, entry] of this.deliveredByKey) {
      if (now - entry.at > this.ttlMs) {
        this.deliveredByKey.delete(key)
      }
    }
    for (const [key, entry] of this.bodyByKey) {
      if (now - entry.at > this.duplicateBodyWindowMs) {
        this.bodyByKey.delete(key)
      }
    }
  }

  private messageKey(sessionKey: string, clientMessageId: string): string {
    return `${sessionKey}\u0000id\u0000${clientMessageId}`
  }

  private bodyKey(sessionKey: string, origin: SessionInputOrigin, body: string): string {
    // Why: a body can be paste-sized; the bounded component keeps a long one out
    // of the map while staying collision-safe (length plus two hashes).
    return `${sessionKey}\u0000body\u0000${origin}\u0000${boundJournalKeyComponent(body)}`
  }
}
