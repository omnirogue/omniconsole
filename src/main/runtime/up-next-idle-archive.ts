/**
 * The owning host's half of the "idle, nothing pending" Done archive (Sal, 27 Sep): an everyday
 * conversation with no outcome plan may leave the list once its window's continuous Done clock
 * elapses, but only while this host positively reads it as finished and holding nothing. Every
 * reading that cannot be made counts as pending; an older host omits the field and archives none.
 *
 * The same facts answer "Archive puts idle agents to sleep" (Sal, 30 Sep): an archived
 * conversation's agent may be stopped only while nothing is in flight and nothing is pending.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { SessionChain } from '../../shared/session-chain-types'
import { isSessionPendingDeliverySettled } from '../../shared/session-pending-delivery-types'
import type { UpNextView } from '../../shared/up-next-types'
import { getSessionPendingDeliveries } from '../session-manage/session-pending-deliveries-runtime'
import {
  isKeepGoingOn,
  readRuntimeOwnSteps
} from '../session-manage/session-manage-runtime-sources'
import { sessionWaitersOf } from '../session-steward/steward-waiter-source'

export type UpNextIdleArchiveFacts = {
  /** Every chain bound to the conversation, finished or not: any plan takes the proven path. */
  chains: number
  finishReady: boolean
  archiveHasWork: boolean
  queuedCount: number
  draftCount: number
  /** Its own proposed next steps (a pending "Should I …?" is waiting-for-yes). */
  ownSteps: number
  keepGoing: boolean
  heldDelivery: boolean
  waiters: number
}

export function upNextIdleArchiveClear(facts: UpNextIdleArchiveFacts): boolean {
  return (
    facts.chains === 0 &&
    facts.finishReady &&
    !facts.archiveHasWork &&
    facts.queuedCount === 0 &&
    facts.draftCount === 0 &&
    facts.ownSteps === 0 &&
    !facts.keepGoing &&
    !facts.heldDelivery &&
    facts.waiters === 0
  )
}

export type UpNextArchiveSleepFacts = Omit<UpNextIdleArchiveFacts, 'chains' | 'finishReady'> & {
  /**
   * Nothing in flight and the reading could be made: a finished turn, or an agent sitting at its
   * own prompt (a resumed pane). Never true while a question or permission prompt is open.
   */
  free: boolean
  /**
   * A queued prompt is being sent, or was just typed in and the agent has not visibly taken it up
   * (the pane still reads free for a moment after a delivery).
   */
  queueDelivery: boolean
}

/**
 * Unlike the Done archive, a finished plan and a resumed agent that has not taken a turn yet both
 * qualify: stopping either loses nothing, and opening the conversation resumes it.
 */
export function upNextArchiveSleepClear(facts: UpNextArchiveSleepFacts): boolean {
  return (
    facts.free &&
    !facts.queueDelivery &&
    !facts.archiveHasWork &&
    facts.queuedCount === 0 &&
    facts.draftCount === 0 &&
    facts.ownSteps === 0 &&
    !facts.keepGoing &&
    !facts.heldDelivery &&
    facts.waiters === 0
  )
}

export type UpNextArchiveReadings = { idleArchiveClear: boolean; archiveSleepClear: boolean }

function heldDelivery(paneKey: string): boolean {
  try {
    return (
      getSessionPendingDeliveries()
        ?.list()
        .some(
          (delivery) =>
            delivery.target.paneKey === paneKey && !isSessionPendingDeliverySettled(delivery)
        ) ?? false
    )
  } catch {
    // Why held: an unreadable hold must never let the archive race it.
    return true
  }
}

/** Reads the facts the Up next view does not carry, only once the cheap ones already hold. */
export async function readUpNextArchiveReadings(
  source: ConversationSource,
  rowKey: string,
  chains: readonly SessionChain[],
  view: Pick<UpNextView, 'finishReady' | 'archiveHasWork' | 'queuedCount' | 'draftCount'> & {
    free: boolean
    queueDelivery?: boolean
  }
): Promise<UpNextArchiveReadings> {
  const base = {
    chains: chains.filter((chain) => chain.sourceRowKey === rowKey).length,
    finishReady: view.finishReady === true,
    free: view.free,
    queueDelivery: view.queueDelivery === true,
    archiveHasWork: view.archiveHasWork !== false,
    queuedCount: view.queuedCount,
    draftCount: view.draftCount,
    ownSteps: 0,
    keepGoing: false,
    heldDelivery: false,
    waiters: 0
  }
  const none = { idleArchiveClear: false, archiveSleepClear: false }
  if (!upNextIdleArchiveClear(base) && !upNextArchiveSleepClear(base)) {
    return none
  }
  try {
    const facts = {
      ...base,
      ownSteps: (await readRuntimeOwnSteps(source)).steps.length,
      keepGoing: isKeepGoingOn(source),
      heldDelivery: heldDelivery(source.paneKey),
      waiters: sessionWaitersOf([source.paneKey, rowKey]).length
    }
    return {
      idleArchiveClear: upNextIdleArchiveClear(facts),
      archiveSleepClear: upNextArchiveSleepClear(facts)
    }
  } catch {
    return none
  }
}

export async function readUpNextIdleArchiveClear(
  source: ConversationSource,
  rowKey: string,
  chains: readonly SessionChain[],
  view: Pick<UpNextView, 'finishReady' | 'archiveHasWork' | 'queuedCount' | 'draftCount'>
): Promise<boolean> {
  return (await readUpNextArchiveReadings(source, rowKey, chains, { ...view, free: false }))
    .idleArchiveClear
}
