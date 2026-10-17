/**
 * `continue --prompt` goes only to a conversation that finished its turn with nothing open: its
 * whole latest reply read, no proposal of its own, no question at its end, and nothing a hard stop
 * covers anywhere in it; or to one the host positively knows never replied at all (a session just
 * launched for a brief). A free prompt never approves (approvals go through `--yes`/`--choose`,
 * which send the step's own words), and it says so to the agent in a fixed line.
 *
 * What was checked is fenced by content: the queue re-checks the fence before delivery and the
 * guarded write before the text and before Enter, and a revocable fence stops the writer itself
 * (`conversation-write-fence.ts`), so a reply that changed, a newer turn or a proposal that arrived
 * later stops the prompt unsent.
 */

import { createHash } from 'node:crypto'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import type { NextStepAdPauses } from '../../shared/next-step-ad-pauses'
import { hardStopOf } from '../next-steps/next-step-keep-going-hard-stops'
import { contextualApprovalOf } from './session-manage-approval'

/** The target's latest finished turn as the host holds it. */
export type SessionLatestTurn = {
  /** The host positively established which turn is the latest. */
  known: boolean
  turnKey: string | null
  /** Its reply as stored, whole or not; null when none is held. */
  text: string | null
  /** `text` is the whole reply: not trimmed, not a preview. */
  complete: boolean
  /** The reply's own parsed proposal, in any status, as its exact content; null when it has none. */
  proposal: string | null
  /** Positively no turn at all (not unread): a conversation that never replied. */
  empty: boolean
}

export const UNREAD_TURN: SessionLatestTurn = {
  known: false,
  turnKey: null,
  text: null,
  complete: false,
  proposal: null,
  empty: false
}

/** After the marker of every relayed free prompt, so its words can never be taken as a go-ahead. */
export const FREEFORM_NOT_AN_APPROVAL =
  "(Not an approval of anything you proposed: deploys, pushes to shared branches, deleting data, sending anything to people, payments, credentials, turning on ads and changing ad budgets or bids still need the person's own go-ahead.)"

function finalParagraph(text: string): string {
  return (
    text
      .trim()
      .split(/\n\s*\n/)
      .pop() ?? ''
  )
}

/** A free prompt that reads as an approval is refused: approvals go through --yes/--choose. */
export function freeformApprovalRefusal(text: string): string | null {
  return contextualApprovalOf(text)
    ? 'That reads as an approval. A free prompt never carries one, so nothing was sent: use --yes or --choose <n>, which send the step’s own words, or ask the person.'
    : null
}

/** Why a free prompt may not go to this conversation now, or null when it may. */
export function freeformRefusal(input: {
  state: SessionManageEntry['state']
  turn: SessionLatestTurn
  /** The target's ad-pause choice; absent = allowed. */
  adPauses?: NextStepAdPauses
}): string | null {
  const { state, turn } = input
  if (state !== 'idle') {
    return `It is ${state}, not idle after a finished turn, so a free prompt would follow a reply this host has not checked; nothing was sent. Wait until it is idle, or answer its own proposal with --yes/--choose.`
  }
  if (turn.known && turn.empty && !turn.turnKey) {
    // Nothing it said can be approved; the prompt's own words passed the hard stops already.
    return null
  }
  if (!turn.known || !turn.turnKey || turn.text === null || !turn.complete) {
    return 'Its latest reply could not be read in full, so nothing was sent: a free prompt goes only after a reply this host has read whole.'
  }
  if (turn.proposal) {
    return 'Its latest reply proposes next steps, so nothing was sent: answer them with --yes or --choose <n>, which send the step’s own words, or ask the person.'
  }
  const stop = hardStopOf(turn.text, input.adPauses)
  if (stop) {
    return `Its latest reply touches something that needs the person (hard stop: ${stop.category}), so a free prompt could read as the go-ahead; nothing was sent. Ask the person.`
  }
  if (finalParagraph(turn.text).includes('?')) {
    return 'Its latest reply ends on a question, so a free prompt could read as the answer; nothing was sent. Ask the person.'
  }
  return null
}

/** What a prompt was checked against: the turn, its reply and, for a free prompt, its proposal. */
export function conversationFence(turn: SessionLatestTurn, withProposal: boolean): string {
  const checked = [
    turn.turnKey,
    turn.text,
    turn.complete,
    turn.empty,
    withProposal ? turn.proposal : null
  ]
  return createHash('sha256').update(JSON.stringify(checked)).digest('hex')
}

/**
 * The conversation guard: run by the queue before delivery and by the guarded write before the
 * text and before Enter. Null only while the conversation is exactly what was checked.
 */
export function conversationGuard(
  fence: string,
  withProposal: boolean,
  readTurn: () => Promise<SessionLatestTurn>
): () => Promise<string | null> {
  return async () => {
    const turn = await readTurn().catch(() => UNREAD_TURN)
    if (!turn.known) {
      return 'Its conversation could not be read just before sending, so the prompt was not sent.'
    }
    return conversationFence(turn, withProposal) === fence
      ? null
      : 'Its conversation changed after this was checked (a newer or different reply, or a new proposal), so the prompt was not sent. Read its latest reply and send again.'
  }
}
