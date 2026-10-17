/**
 * Up next, read off this host: the ordered chain of one conversation, thread or card.
 *
 * The only place that gathers the things the view is made of — the prompt queue for this
 * conversation, the live chain bound to it, the blocks being composed, and one reading of
 * whether its own agent is busy — and hands them to the pure projection. It writes nothing,
 * and a subject with no queue and no chain is answered with an empty chain rather than an
 * error: ordinary conversation creates nothing (frozen model, invariant 2).
 */

import type { SessionChain } from '../../shared/session-chain-types'
import {
  isUpNextConversation,
  upNextRowKey,
  type UpNextConversationId,
  type UpNextView
} from '../../shared/up-next-types'
import { observeConversationReadiness } from './conversation-readiness'
import type { OrcaRuntimeService } from './omni-runtime'
import { isFinishedOutcomeChain } from './session-outcome-source-uniqueness'
import { projectUpNext } from './up-next-projection'
import { sessionArchiveProof } from '../../shared/session-archive-proof'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { sessionWaitersOf } from '../session-steward/steward-waiter-source'
import { stewardFeatureOn } from '../session-steward/steward-switches'
import { readUpNextArchiveReadings } from './up-next-idle-archive'
import { isPromptQueueDeliveryHeld, isPromptQueueSendingOnConversation } from './prompt-queue-drain'

/**
 * The chain this conversation is pursuing: the live outcome chain when there is one,
 * else the most recent finished one, so a closed pursuit still reads as closed.
 * `sourceRowKey` and `conversationSourceRowKey` are the same string for one pane.
 */
export function upNextChainFor(runtime: OrcaRuntimeService, rowKey: string): SessionChain | null {
  const candidates = runtime
    .listSessionChains()
    .filter((chain) => chain.sourceRowKey === rowKey && chain.outcomeSet && !chain.quarantine)
  return (
    candidates.find((chain) => !isFinishedOutcomeChain(chain)) ??
    candidates.reduce<SessionChain | null>(
      (latest, chain) => (!latest || chain.updatedAt > latest.updatedAt ? chain : latest),
      null
    )
  )
}

export async function upNextView(
  runtime: OrcaRuntimeService,
  conversationId: UpNextConversationId
): Promise<UpNextView> {
  const rowKey = upNextRowKey(conversationId)
  const drafts = runtime.readUpNextDrafts(rowKey)?.entries ?? []
  // A thread or a card has no agent of its own yet: there is nothing to be busy, nothing
  // queued and no plan — only what the person is composing for it.
  if (!isUpNextConversation(conversationId)) {
    return projectUpNext({
      conversationId,
      rowKey,
      chain: null,
      queue: null,
      drafts,
      busy: false,
      now: Date.now()
    })
  }
  const readiness = await observeConversationReadiness(runtime, conversationId)
  // A reading that could not be made is not evidence the agent is free: an
  // unverifiable conversation counts as busy, so nothing defaults to interrupting it.
  // It is the FREE reading, not "a turn finished": an agent sitting at its own prompt with no
  // turn behind it is idle, and the Now row said "working · 2 min" about it for as long as the
  // pane stayed open (round-4 live sim, cli/10k, 10o).
  const busy = !readiness.free
  const chain = upNextChainFor(runtime, rowKey)
  const view = projectUpNext({
    conversationId,
    rowKey,
    chain,
    queue: runtime.readPromptQueue(rowKey),
    drafts,
    busy,
    // A send carries the conversation only where this host can read it, the same reading its
    // commit makes (`up-next-commit.ts`); asked only while a send is being composed.
    ...(drafts.some((entry) => entry.input.kind === 'person')
      ? {
          sendsConversation: Boolean(
            runtime.getSessionOutcomeTranscriptSource(
              chain ?? {
                sourcePaneKey: conversationId.paneKey,
                worktreeId: conversationId.worktreeId
              }
            )
          )
        }
      : {}),
    // Who is working, what on, and since when — the three things the Now row says
    // (v3 amendment 1). Each is the host's own reading, and absent when it has none. The
    // agent is read either way: an IDLE row names it too ("Claude Code · waiting for you"),
    // while the activity and the elapsed belong to a turn that is actually running.
    agent: runtime.conversationAgent(conversationId.paneKey) ?? '',
    ...(busy
      ? {
          ...(readiness.activity ? { activity: readiness.activity } : {}),
          ...(readiness.busySince !== undefined ? { busySince: readiness.busySince } : {})
        }
      : {}),
    now: Date.now()
  })
  const finishReady =
    readiness.ready &&
    !readiness.unverifiable &&
    (!chain || (chain.state !== 'cancelled' && isFinishedOutcomeChain(chain))) &&
    view.blocks.every((block) => block.kind === 'done' || block.state === 'done')
  const archiveHasWork = Boolean(
    (!readiness.unverifiable && !readiness.free) ||
    getStructuredAgentSessionHost()?.outcomeSource.hasBackgroundWork(
      conversationId.paneKey,
      conversationId.worktreeId
    ) ||
    view.blocks.some((block) => block.kind !== 'done' && block.state !== 'done') ||
    runtime
      .listSessionChains()
      .some((other) => other.sourceRowKey === rowKey && !isFinishedOutcomeChain(other))
  )
  // Why: a session another one waits on stays until that waiter has picked up its result.
  const awaited =
    stewardFeatureOn('tier1WaiterCheck') &&
    sessionWaitersOf([conversationId.paneKey, rowKey]).length > 0
  const archiveProof =
    chain &&
    finishReady &&
    !archiveHasWork &&
    !awaited &&
    readiness.version === chain.outcomeSet?.continuation.sourceVersion
      ? sessionArchiveProof(chain)
      : null
  const { idleArchiveClear, archiveSleepClear } = await readUpNextArchiveReadings(
    conversationId,
    rowKey,
    runtime.listSessionChains(),
    {
      ...view,
      finishReady,
      archiveHasWork,
      free: readiness.free && !readiness.unverifiable,
      queueDelivery:
        isPromptQueueSendingOnConversation(runtime, conversationId) ||
        isPromptQueueDeliveryHeld(runtime, rowKey, readiness)
    }
  )
  return {
    ...view,
    finishReady,
    archiveHasWork,
    idleArchiveClear,
    archiveSleepClear,
    ...(archiveProof ? { archiveProof } : {})
  }
}
