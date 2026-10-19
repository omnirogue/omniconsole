/**
 * Answers OmniOS addressed to a Claude/Codex conversation on this computer, waiting for that
 * agent's own hooks to carry them in (answerDelivery.hookFirst pilot). An item is offered,
 * reserved by one hook reply (`sending`), injected only when that hook acknowledges it printed the
 * reply, and confirmed when the same conversation in the same pane and launch reports a later step.
 * Every hand-out is recorded: a Stop block is spent when handed out, an acknowledgement counts once,
 * and an answer goes out by hook at most ANSWER_MAX_HOOK_COPIES times, even across a withdrawal; any
 * further attempt is the typed path's single copy.
 * Conversations are matched only on ids the hook payload itself carries, never on inherited env.
 */

import {
  ANSWER_MAX_HOOK_COPIES,
  conversationMatches,
  eligibleFor,
  holderMatches,
  sameHolder
} from './answer-inbox-match'

export { ANSWER_MAX_HOOK_COPIES }

export type AnswerProvider = 'claude' | 'codex'

export type AnswerHookEvent = 'UserPromptSubmit' | 'PostToolUse' | 'Stop' | 'SessionStart'

export type AnswerDeliveryPath =
  | 'hook_stop'
  | 'hook_post_tool'
  | 'hook_prompt'
  | 'hook_session_start'
  | 'typed_fallback'

export const ANSWER_PATH_BY_EVENT: Record<AnswerHookEvent, AnswerDeliveryPath> = {
  UserPromptSubmit: 'hook_prompt',
  PostToolUse: 'hook_post_tool',
  Stop: 'hook_stop',
  SessionStart: 'hook_session_start'
}

/** Injected but not confirmed for this long: offered again. */
export const ANSWER_REOFFER_AFTER_MS = 10 * 60_000
/** Hand-out records kept per item (an acknowledgement older than these counts for nothing). */
const ANSWER_SENDS_KEPT = 8
/** Withdrawn answers whose spent hook copies are remembered, so a re-offer cannot spend them again. */
const ANSWER_SPENT_KEPT = 200

/** The conversation an item is addressed to: provider plus the session id the hub resolved. */
export type AnswerConversation = { provider: AnswerProvider; sessionId: string }

/** The pane holding the conversation, the launch recorded for it, and its agent pid if proven. */
export type HolderIdentity = { paneKey: string; launchHash: string; agentPid: number | null }

/** An accepted hook: its provider, conversation ids, pane, launch and agent pid. */
export type HookConversation = {
  provider: AnswerProvider
  ids: readonly string[]
  paneKey: string
  /** sha256 of the hook's launch token. */
  launchHash: string | null
  agentPid: number | null
}

/** One reply handed out for an item, and what became of it. */
export type AnswerSend = {
  nonce: string
  event: AnswerHookEvent
  holder: HolderIdentity
  at: number
  /** `lost`: no acknowledgement in time (one may still arrive late and counts then). */
  outcome: 'sent' | 'acked' | 'lost'
  /** A later step of its holder arrived before the acknowledgement: confirmed when it lands. */
  provenAt: number | null
}

export type AnswerItemState = 'offered' | 'sending' | 'injected' | 'confirmed'

export type AnswerItem = {
  /** The work-delivery queue id (derived from the delivery key). */
  id: string
  deliveryKey: string
  conversation: AnswerConversation
  /** Null only while a resume is reopening the conversation. */
  holder: HolderIdentity | null
  /** Exactly the text the typed path would send. */
  text: string
  /** The shortened copy built from the delivery's own fields, or null (only the full text). */
  compact: string | null
  offeredAt: number
  state: AnswerItemState
  /** How many replies a hook acknowledged printing. */
  attempts: number
  /** Replies handed out that no hook acknowledged (a restart mid-reply counts as one). */
  unacked: number
  /** A Stop reply blocking for it was handed out once (acknowledged or not); never again. */
  stopOffered: boolean
  reofferedAt: number | null
  injectedAt: number | null
  injectedBy: AnswerHookEvent | null
  confirmedAt: number | null
  /** The latest replies handed out for it, oldest first. */
  sends: AnswerSend[]
}

export type AnswerTakeEvent = {
  name: AnswerHookEvent
  /** Claude/Codex Stop: the turn is already continuing because a Stop hook blocked. */
  stopHookActive?: boolean
}

const sendOf = (item: AnswerItem | undefined, nonce: string) =>
  item?.sends.find((send) => send.nonce === nonce)

/** Hand-outs whose acknowledgement never came are counted as lost (a restart or a withdrawal). */
const settledSends = (sends: AnswerSend[]): AnswerSend[] =>
  sends.map((send) => (send.outcome === 'sent' ? { ...send, outcome: 'lost' as const } : send))

export function answerConversationText(conversation: AnswerConversation): string {
  return `${conversation.provider}:${conversation.sessionId}`
}

export class AnswerInbox {
  private readonly items = new Map<string, AnswerItem>()
  private readonly spent = new Map<string, AnswerSend[]>()

  constructor(
    private readonly options: {
      now?: () => number
      onChange?: (item: AnswerItem) => void
    } = {}
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private changed(item: AnswerItem): void {
    this.options.onChange?.(item)
  }

  isEmpty(): boolean {
    return this.items.size === 0
  }

  get(id: string): AnswerItem | undefined {
    return this.items.get(id)
  }

  /** Idempotent per id: an item already here keeps its state. */
  offer(
    conversation: AnswerConversation,
    input: Pick<AnswerItem, 'id' | 'deliveryKey' | 'text' | 'compact' | 'holder'>
  ): AnswerItem {
    const existing = this.items.get(input.id)
    if (existing) {
      return existing
    }
    // Why: a re-offer after a withdrawal keeps the hook copy it already spent.
    const sends = this.spent.get(input.id) ?? []
    this.spent.delete(input.id)
    const item: AnswerItem = {
      ...input,
      conversation,
      offeredAt: this.now(),
      state: 'offered',
      attempts: 0,
      unacked: sends.filter((send) => send.outcome !== 'acked').length,
      stopOffered: sends.some((send) => send.event === 'Stop'),
      reofferedAt: null,
      injectedAt: null,
      injectedBy: null,
      confirmedAt: null,
      sends
    }
    this.items.set(item.id, item)
    this.changed(item)
    return item
  }

  /** Puts back an item read from disk; a reply the restart cut off counts as never acknowledged. */
  restore(saved: AnswerItem): void {
    const item: AnswerItem = { ...saved, unacked: saved.unacked ?? 0, sends: saved.sends ?? [] }
    if (item.state === 'sending') {
      item.state = 'offered'
      item.unacked += item.sends.filter((send) => send.outcome === 'sent').length
      item.sends = settledSends(item.sends)
    }
    this.items.set(item.id, item)
  }

  /** The holder recorded at handover; an item a hook carried for another holder is offered again. */
  bind(id: string, holder: HolderIdentity): void {
    const item = this.items.get(id)
    if (!item || (sameHolder(item.holder, holder) && item.holder?.agentPid === holder.agentPid)) {
      return
    }
    if (item.holder !== null && !sameHolder(item.holder, holder) && item.state !== 'confirmed') {
      item.state = 'offered'
    }
    item.holder = holder
    this.changed(item)
  }

  /** The oldest item this event may carry for its conversation and holder; nothing changes yet. */
  take(hook: HookConversation, event: AnswerTakeEvent): AnswerItem | null {
    let oldest: AnswerItem | null = null
    for (const item of this.items.values()) {
      if (
        conversationMatches(item, hook) &&
        holderMatches(item.holder, hook) &&
        eligibleFor(item, event)
      ) {
        if (!oldest || item.offeredAt < oldest.offeredAt) {
          oldest = item
        }
      }
    }
    return oldest
  }

  /**
   * Held for one reply, so a concurrent hook cannot carry it too. Recorded (and saved) before the
   * reply goes out; a Stop block is spent here, not on the acknowledgement. False: not handed out.
   */
  reserve(id: string, nonce: string, event: AnswerHookEvent, hook: HookConversation): boolean {
    const item = this.items.get(id)
    if (
      !item ||
      (item.state !== 'offered' && item.state !== 'injected') ||
      item.sends.length >= ANSWER_MAX_HOOK_COPIES ||
      !hook.launchHash
    ) {
      return false
    }
    item.state = 'sending'
    if (event === 'Stop') {
      item.stopOffered = true
    }
    const holder = { paneKey: hook.paneKey, launchHash: hook.launchHash, agentPid: hook.agentPid }
    const send: AnswerSend = {
      nonce,
      event,
      holder,
      at: this.now(),
      outcome: 'sent',
      provenAt: null
    }
    item.sends = [...item.sends, send].slice(-ANSWER_SENDS_KEPT)
    this.changed(item)
    return true
  }

  /** No acknowledgement for this reply in time (late, closed or lost): offered again. */
  release(id: string, nonce: string): void {
    const item = this.items.get(id)
    const send = sendOf(item, nonce)
    if (!item || send?.outcome !== 'sent') {
      return
    }
    send.outcome = 'lost'
    item.unacked += 1
    if (item.state === 'sending' && item.sends.at(-1) === send) {
      item.state = 'offered'
    }
    this.changed(item)
  }

  /**
   * The hook printed this reply: carried into the agent's context. A late acknowledgement still
   * counts; one already counted (or too old to be on record) changes nothing.
   */
  ack(id: string, nonce: string): boolean {
    const item = this.items.get(id)
    const send = sendOf(item, nonce)
    if (!item || !send) {
      return false
    }
    if (send.outcome === 'acked') {
      return true
    }
    if (send.outcome === 'lost') {
      item.unacked = Math.max(0, item.unacked - 1)
    }
    send.outcome = 'acked'
    item.attempts += 1
    item.holder ??= send.holder
    if (item.state !== 'confirmed') {
      if (item.state !== 'injected') {
        item.injectedAt = this.now()
        item.injectedBy = send.event
      }
      item.state = send.provenAt === null ? 'injected' : 'confirmed'
      item.confirmedAt = send.provenAt === null ? null : this.now()
    }
    this.changed(item)
    return true
  }

  /**
   * A later step of the same conversation from its holder proves it continued past every
   * injection. A replayed spool record passes its own time: only earlier injections count. A step
   * that arrives before a reply's acknowledgement is kept and confirms the item when it lands.
   */
  confirm(hook: HookConversation, at: number = Number.POSITIVE_INFINITY): AnswerItem[] {
    const confirmed: AnswerItem[] = []
    for (const item of this.items.values()) {
      if (!conversationMatches(item, hook)) {
        continue
      }
      if (
        item.state === 'injected' &&
        item.injectedAt !== null &&
        item.injectedAt < at &&
        holderMatches(item.holder, hook)
      ) {
        item.state = 'confirmed'
        item.confirmedAt = this.now()
        confirmed.push(item)
        this.changed(item)
        continue
      }
      const pending = item.state === 'confirmed' ? undefined : item.sends.at(-1)
      if (
        pending &&
        pending.outcome !== 'acked' &&
        pending.provenAt === null &&
        pending.at < at &&
        holderMatches(pending.holder, hook)
      ) {
        pending.provenAt = this.now()
        this.changed(item)
      }
    }
    return confirmed
  }

  /** Removes an item that has not been confirmed (its delivery fell back or was refused). */
  withdraw(id: string): AnswerItem | null {
    const item = this.items.get(id)
    if (!item || item.state === 'confirmed') {
      return null
    }
    this.items.delete(id)
    if (item.sends.length > 0) {
      this.spent.set(id, settledSends(item.sends))
      if (this.spent.size > ANSWER_SPENT_KEPT) {
        this.spent.delete(this.spent.keys().next().value!)
      }
    }
    return item
  }

  /** Forgets any item, confirmed ones included (settled and reported). */
  forget(id: string): void {
    this.items.delete(id)
    this.spent.delete(id)
  }

  /** Injected but unconfirmed for ANSWER_REOFFER_AFTER_MS: offered again. */
  reofferStale(): AnswerItem[] {
    const now = this.now()
    const reoffered: AnswerItem[] = []
    for (const item of this.items.values()) {
      if (
        item.state === 'injected' &&
        item.injectedAt !== null &&
        now - item.injectedAt >= ANSWER_REOFFER_AFTER_MS
      ) {
        item.state = 'offered'
        item.reofferedAt = now
        reoffered.push(item)
        this.changed(item)
      }
    }
    return reoffered
  }

  all(): AnswerItem[] {
    return [...this.items.values()]
  }
}
