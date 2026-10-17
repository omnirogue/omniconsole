/**
 * Each pane's latest finished turn, as this relay heard it from its agents' hooks. A turn is known
 * only from a `done` report: its identity is the provider's prompt id (or the hook's per-turn key),
 * so the revision moves exactly when the agent finishes a turn and a delivered prompt leaves it
 * where it was until the agent answers. Waiters and questions listen for the next finished turn.
 */

import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { sessionHostDigest } from '../shared/session-host-identity'

export type RelayFinishedTurn = {
  paneKey: string
  providerSessionId: string | null
  /** The provider's prompt id or the hook's per-turn key; a counter when it gave neither. */
  identity: string
  at: number
  reply: string | null
}

type Listener = (turn: RelayFinishedTurn) => void

export class RelayTurnLedger {
  private readonly latest = new Map<string, RelayFinishedTurn>()
  private readonly reportedAt = new Map<string, number>()
  private readonly listeners = new Set<Listener>()
  private counter = 0

  constructor(
    /** This relay process; a counter-based identity is only ever unique within it. */
    private readonly incarnation: string,
    private readonly now: () => number = Date.now
  ) {}

  /** Fed every applied hook report. */
  apply(event: AgentHookEventPayload): void {
    this.reportedAt.set(event.paneKey, this.now())
    if (event.payload.state !== 'done') {
      return
    }
    const identity =
      event.providerPromptId ??
      event.promptInteractionKey ??
      `${this.incarnation}:${(this.counter += 1)}`
    const held = this.latest.get(event.paneKey)
    // Why: a replay or a repeated delivery of the same finished turn is not a new turn.
    if (held?.identity === identity) {
      return
    }
    const turn: RelayFinishedTurn = {
      paneKey: event.paneKey,
      providerSessionId: event.providerSession?.id ?? null,
      identity,
      at: this.now(),
      reply: event.payload.lastAssistantMessage ?? null
    }
    this.latest.set(event.paneKey, turn)
    for (const listener of this.listeners) {
      listener(turn)
    }
  }

  forget(paneKey: string): void {
    this.latest.delete(paneKey)
    this.reportedAt.delete(paneKey)
  }

  /** When the pane's agent last reported anything; null when it has not since this relay started. */
  lastReportAt(paneKey: string): number | null {
    return this.reportedAt.get(paneKey) ?? null
  }

  latestFor(paneKey: string): RelayFinishedTurn | null {
    return this.latest.get(paneKey) ?? null
  }

  /** Null until a finished turn is known: admission then refuses (`turn-unknown`). */
  revision(paneKey: string): string | null {
    const turn = this.latest.get(paneKey)
    if (!turn) {
      return null
    }
    const digest = sessionHostDigest(
      `relay-turn/v1\n${paneKey}\n${turn.providerSessionId ?? ''}\n${turn.identity}`
    )
    return `turn:${digest.slice('sha256:'.length, 'sha256:'.length + 32)}`
  }

  /** The pane's next finished turn after now, or null once `timeoutMs` passes. */
  nextTurn(paneKey: string, timeoutMs: number): Promise<RelayFinishedTurn | null> {
    return new Promise((resolve) => {
      const done = (turn: RelayFinishedTurn | null) => {
        clearTimeout(timer)
        this.listeners.delete(listener)
        resolve(turn)
      }
      const listener: Listener = (turn) => {
        if (turn.paneKey === paneKey) {
          done(turn)
        }
      }
      const timer = setTimeout(() => done(null), timeoutMs)
      this.listeners.add(listener)
    })
  }
}
