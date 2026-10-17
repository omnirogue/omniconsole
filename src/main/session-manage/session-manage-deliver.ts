/**
 * The shared half of `omni session continue|ask`: another conversation's words reach a target only
 * through the target's own prompt queue (which waits until the target is free), behind a visible
 * marker naming who sent them, and never beside the target's own Keep going.
 *
 * Order: every check and the queue's admission first; then Keep going OFF (as the person's own
 * answer does); then the prompt, bound to the agent process that holds the target's terminal now
 * and, for `continue`, to the conversation it was checked against (`session-manage-continue.ts`).
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { NextStepsDecideResult } from '../../shared/next-step-suggestions-rpc'
import type { PromptQueueEnqueueInput } from '../../shared/prompt-queue-types'
import type { SessionManageActor, SessionManageEntry } from '../../shared/session-manage-types'
import type { NextStepRelayedRun } from '../next-steps/next-step-decisions'
import type { TerminalAgentProcessProof } from '../runtime/terminal-agent-process'
import type { SessionPromptBinding } from '../runtime/session-prompt-binding'
import type { SessionLatestTurn } from './session-manage-freeform'
import { isSelfTarget } from './session-manage-caller'
import { remoteExecutionRefusal } from './session-manage-locality'
import { afterApplied, SessionManageRefusal } from './session-manage-refusal'
import type { SessionOwnSteps } from './session-manage-steps'
import { UNRESOLVED_DRAFT_REASON } from '../runtime/terminal-unresolved-draft'

export { refuseHardStop, SessionManageRefusal } from './session-manage-refusal'

export type SessionDeliveryDeps = {
  enqueue(source: ConversationSource, input: PromptQueueEnqueueInput): void
  /** Why the queue would refuse this text now (empty, too long, full); null when it has room. */
  admission(source: ConversationSource, text: string): string | null
  /** Binds a queued entry to its receiver and conversation guard; returns the release. */
  bind(source: ConversationSource, entryId: string, binding: SessionPromptBinding): () => void
  /** The target's latest finished turn, its reply and its own proposal, as the host holds them. */
  readLatestTurn(source: ConversationSource): Promise<SessionLatestTurn>
  /** The same, synchronously, from memory: a fence open on it is revoked once this changes. */
  snapshotLatestTurn(source: ConversationSource): SessionLatestTurn
  /** Current provider conversation reported by a terminal's own hooks, independent of its turn. */
  providerSessionId?(source: ConversationSource): string | null
  /** Its input box holds text a refused prompt left (`terminal-unresolved-draft.ts`). */
  hasUnresolvedDraft(source: ConversationSource): boolean
  decideRelayed(
    setId: string,
    suggestionId: string,
    relayed: NextStepRelayedRun
  ): Promise<NextStepsDecideResult>
  /** Turns the target's Keep going off with the reason; true when it was on. */
  stopKeepGoing(source: ConversationSource, detail: string): boolean
  /** Whether Keep going drives it now, read without changing it (a steward run refuses then). */
  keepGoingOn?(source: ConversationSource): boolean
  readOwnSteps(source: ConversationSource): Promise<SessionOwnSteps>
  newId(): string
}

export type SessionDeliveryTarget = {
  entry: SessionManageEntry
  source: ConversationSource | null
  /** The pid proof behind a terminal's `agentForeground: true`. */
  agentProcess?: TerminalAgentProcessProof | null
}

export type SessionManageAnswer =
  | { kind: 'yes' }
  | { kind: 'choose'; choice: number }
  | { kind: 'prompt'; text: string }

export type Deliverable = { source: ConversationSource; proof: TerminalAgentProcessProof | null }

/** Every check a prompt to another session must pass before anything is queued. */
export function assertDeliverable(
  actor: SessionManageActor,
  target: SessionDeliveryTarget,
  verb: 'continue' | 'ask'
): Deliverable {
  const { entry, source } = target
  const name = `“${entry.title}”`
  if (isSelfTarget(actor, entry.paneKey)) {
    throw new SessionManageRefusal(
      `That is the session running this command; it cannot ${verb} itself. Nothing was sent.`
    )
  }
  const remote = remoteExecutionRefusal(entry, verb)
  if (remote) {
    throw new SessionManageRefusal(remote)
  }
  if (entry.verdict === 'exited') {
    throw new SessionManageRefusal(
      `${name} has exited, so nothing was sent. Resume it first: omni session restart --pane ${entry.paneKey ?? '<paneKey>'}`
    )
  }
  // Why unknown too: a pane whose agent is not confirmed running may be at a shell, and a
  // queued prompt must never become a shell command.
  if (!source || entry.verdict !== 'live' || entry.state === 'unknown') {
    throw new SessionManageRefusal(
      `${name} cannot be verified (${entry.waitingOn ?? 'its host is not reachable'}), so nothing was sent.`
    )
  }
  // Why process proof: the prompt is typed into the terminal, so only its agent may hold it.
  const proof = entry.kind === 'terminal' ? (target.agentProcess ?? null) : null
  if (entry.kind === 'terminal' && (entry.agentForeground !== true || !proof)) {
    throw new SessionManageRefusal(
      `${name}'s agent could not be proven to hold its terminal (${
        entry.agentForeground === false
          ? 'a shell, another program or another agent is in the foreground'
          : 'its foreground process could not be read'
      }), so nothing was sent: a prompt must never reach a shell or another program.`
    )
  }
  if (entry.state === 'awaiting-user') {
    throw new SessionManageRefusal(
      `${name} is waiting on the person — ${entry.waitingOn ?? 'a question or permission prompt'} A queued prompt cannot answer that (it is sent only once the session is free), so nothing was sent. Answer it in that session.`
    )
  }
  if (entry.state === 'provider-limited') {
    throw new SessionManageRefusal(
      `${name} is held by a provider usage limit; a new prompt would cancel its recovery, so nothing was sent.`
    )
  }
  return { source, proof }
}

export function refuseAdmission(
  deps: Pick<SessionDeliveryDeps, 'admission' | 'hasUnresolvedDraft'>,
  source: ConversationSource,
  text: string
): void {
  if (deps.hasUnresolvedDraft(source)) {
    throw new SessionManageRefusal(`${UNRESOLVED_DRAFT_REASON} Nothing was sent.`)
  }
  const refusal = deps.admission(source, text)
  if (refusal) {
    throw new SessionManageRefusal(`${refusal} Nothing was sent.`)
  }
}

/**
 * Keep going off, then the queueing, bound to the target's agent process and (for `continue`) the
 * conversation guard. A failure once Keep going changed is partial (the handler audits it); the
 * binding never outlives a failed queueing.
 */
export async function relayPrompt(
  deps: Pick<SessionDeliveryDeps, 'stopKeepGoing' | 'bind'>,
  deliverable: Deliverable,
  entryId: string,
  detail: string,
  queue: () => Promise<void>,
  conversation?: Pick<SessionPromptBinding, 'conversationGuard' | 'conversationStill'>
): Promise<boolean> {
  const { source, proof } = deliverable
  const stopped = deps.stopKeepGoing(source, detail)
  const release = deps.bind(source, entryId, { receiver: proof, ...conversation })
  await afterApplied(stopped ? 'its Keep going was turned off' : null, async () => {
    try {
      await queue()
    } catch (error) {
      release()
      throw error
    }
  })
  return stopped
}

export function queuedWords(entry: SessionManageEntry, dryRun: boolean): string {
  return dryRun
    ? `(dry run: nothing changed; it would be sent when “${entry.title}” is free)`
    : `It is sent when “${entry.title}” is free.`
}
