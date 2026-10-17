/**
 * Session Questions on OmniOS, the logic only (no timers, no network): which of this computer's
 * pending session questions OmniOS should hold, what changed since the last sync, and how one
 * round of answers collected from OmniOS is applied and acknowledged.
 *
 * Naming: a "Question" is a session asking its person (AskUserQuestion and its equivalents);
 * OmniOS "Decisions" are artifact review pages and have nothing to do with this module.
 */

import { createHash } from 'node:crypto'
import type { SessionDecision } from '../../shared/session-decisions'
import {
  beginCardTyping,
  cardTouched,
  cardTypingOutcome,
  endCardTyping,
  leftToClaimer
} from '../answer-delivery/answer-delivery-handover'

export type OmniosQuestionOption = { label: string; description: string }

export type OmniosQuestionItem = {
  fingerprint: string
  paneKey: string
  sessionId: string
  toolUseId: string
  title: string
  agent: string
  askedAt: string
  questions: {
    header: string
    question: string
    multiSelect: boolean
    options: OmniosQuestionOption[]
  }[]
}

export type OmniosQuestionSyncBody = {
  host: string
  /** This runtime's session-host id: the one its delivery claimer polls with. */
  hostId?: string
  full: boolean
  items: OmniosQuestionItem[]
  resolved: string[]
}

/** One answer the person gave on OmniOS, as `GET /api/session-questions/answers` returns it. */
export type OmniosQuestionAnswer = {
  id: string
  fingerprint: string
  paneKey: string
  sessionId: string
  toolUseId: string
  /** Question text → the chosen label or typed text. */
  answers: Record<string, string>
  skipped: boolean
  /** The answer's work delivery on OmniOS; the delivery claimer takes it when it polls questions. */
  deliveryKey?: string | null
}

export type OmniosApplyOutcome = { delivered: true } | { delivered: false; error: string }

/**
 * A question's OmniOS identity: sha256 of `sessionQuestionIdentity` (provider session id, a
 * newline, then the raw ask), so the same question mirrored into a second pane is one item.
 * Without a provider session the pane key stands in for it, as `sessionDecisionKey` does. The
 * asking tool call (or, without one, when it was asked) follows, because OmniOS never reopens a
 * resolved fingerprint: the same question asked again must be a new item.
 */
export function omniosQuestionFingerprint(
  decision: Pick<
    SessionDecision,
    'paneKey' | 'providerSession' | 'interactivePrompt' | 'toolUseId' | 'askedAt'
  >
): string {
  const owner = decision.providerSession?.id?.trim() || decision.paneKey
  const ask = decision.toolUseId?.trim() || `asked:${decision.askedAt}`
  return createHash('sha256')
    .update(`${owner}\n${decision.interactivePrompt}\n${ask}`)
    .digest('hex')
}

/** What OmniOS should hold now: every question a live session still waits on. */
export function omniosQuestionItems(decisions: readonly SessionDecision[]): OmniosQuestionItem[] {
  const items = new Map<string, OmniosQuestionItem>()
  for (const decision of decisions) {
    // Why live only: an ended session's question is answered by resuming it at the desktop,
    // which OmniOS cannot do; the session ending resolves it there.
    if (decision.endedAt !== null || decision.questions.length === 0) {
      continue
    }
    const fingerprint = omniosQuestionFingerprint(decision)
    if (items.has(fingerprint)) {
      continue
    }
    items.set(fingerprint, {
      fingerprint,
      paneKey: decision.paneKey,
      sessionId: decision.providerSession?.id ?? '',
      toolUseId: decision.toolUseId ?? '',
      title: decision.title ?? '',
      agent: decision.agent ?? '',
      askedAt: new Date(decision.askedAt).toISOString(),
      questions: decision.questions.map((question) => ({
        header: question.header ?? '',
        question: question.question,
        multiSelect: question.multiSelect,
        options: question.options.map((option) => ({
          label: option.label,
          description: option.description ?? ''
        }))
      }))
    })
  }
  return [...items.values()]
}

/**
 * Remembers what OmniOS last accepted and turns the current list into the next sync body: new
 * or changed items plus the fingerprints that left; null when there is nothing to send. A full
 * sync lists everything, and OmniOS resolves whatever it holds for this host that is not listed.
 */
export class OmniosQuestionPublisherState {
  private sent = new Map<string, string>()

  next(
    host: string,
    current: readonly OmniosQuestionItem[],
    full: boolean
  ): OmniosQuestionSyncBody | null {
    const now = new Map(current.map((item) => [item.fingerprint, item]))
    const resolved = [...this.sent.keys()].filter((fingerprint) => !now.has(fingerprint))
    const items = full
      ? [...now.values()]
      : [...now.values()].filter((item) => this.sent.get(item.fingerprint) !== JSON.stringify(item))
    if (!full && items.length === 0 && resolved.length === 0) {
      return null
    }
    return { host, full, items, resolved }
  }

  /** OmniOS accepted `body`; later diffs start from it. */
  accepted(body: OmniosQuestionSyncBody): void {
    if (body.full) {
      this.sent.clear()
    }
    for (const fingerprint of body.resolved) {
      this.sent.delete(fingerprint)
    }
    for (const item of body.items) {
      this.sent.set(item.fingerprint, JSON.stringify(item))
    }
  }

  reset(): void {
    this.sent.clear()
  }
}

/**
 * One round of answers: each is applied to the question still pending under its fingerprint,
 * then acknowledged — `delivered: true` only once the pane took it. A question no longer pending
 * here, or an answer that could not be applied, is acknowledged as not delivered with the reason,
 * so the person sees it on OmniOS instead of waiting forever. An answer with a `deliveryKey` is left
 * to the delivery claimer while it polls, and never typed into its card twice by either path.
 * Returns how many were delivered.
 */
export async function runOmniosAnswerRound(deps: {
  fetchAnswers: () => Promise<OmniosQuestionAnswer[] | null>
  isPending: (fingerprint: string) => boolean
  apply: (answer: OmniosQuestionAnswer) => Promise<OmniosApplyOutcome>
  ack: (id: string, outcome: OmniosApplyOutcome) => Promise<boolean>
  /** Answers typed in whose acknowledgement has not reached OmniOS yet; kept across rounds. */
  unacked: Set<string>
}): Promise<{ ok: boolean; delivered: number }> {
  const answers = await deps.fetchAnswers()
  if (!answers) {
    return { ok: false, delivered: 0 }
  }
  const listed = new Set(answers.map((answer) => answer.id))
  for (const id of deps.unacked) {
    if (!listed.has(id)) {
      deps.unacked.delete(id)
    }
  }
  let delivered = 0
  for (const answer of answers) {
    const key = answer.deliveryKey
    let outcome: OmniosApplyOutcome
    if (deps.unacked.has(answer.id)) {
      // Why: typed in last round, then the ack was lost; never type it twice or report it gone.
      outcome = { delivered: true }
    } else if (key && (leftToClaimer('question', key) || cardTouched(key))) {
      // Why no ack: the claimer delivers it, or its card was typed into already; its line reports it.
      continue
    } else if (!deps.isPending(answer.fingerprint)) {
      if (key) {
        // Why: its delivery reopens the session; "no longer waiting" would wrongly fail it.
        continue
      }
      outcome = {
        delivered: false,
        error: 'The session is no longer waiting on this question; nothing was typed.'
      }
    } else {
      if (key) {
        beginCardTyping(key)
      }
      outcome = await deps
        .apply(answer)
        .catch(
          () => ({ delivered: false, error: 'The desktop could not apply this answer.' }) as const
        )
      if (key) {
        endCardTyping(key, cardTypingOutcome(outcome))
      }
    }
    if (outcome.delivered) {
      delivered += 1
      deps.unacked.add(answer.id)
    }
    if (await deps.ack(answer.id, outcome).catch(() => false)) {
      deps.unacked.delete(answer.id)
    }
  }
  return { ok: true, delivered }
}
