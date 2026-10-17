/** How a handed-over delivery's turn is read: a short turn, a login cut, and the turn ending. */

import {
  WORK_DELIVERY_AGENT_START_WAIT_MS,
  WORK_DELIVERY_DONE_FOLLOW_MS,
  WORK_DELIVERY_DONE_IDLE_GAP_MS,
  type Watch,
  type WorkDeliveryDeps,
  type WorkPane
} from './work-delivery-claimer-types'
import type { WorkDeliveryHeldReason } from './work-delivery-kind'
import type { ClaimerLedger } from './work-delivery-watch'

/** Waits for a just-reopened agent, then reads the turn this delivery's own turn must follow. */
export async function prepareHandover(
  deps: WorkDeliveryDeps,
  pane: WorkPane,
  started: boolean
): Promise<string | null | undefined> {
  // Why: a pane just reopened runs its agent a moment later; sending earlier would be refused.
  if (started && deps.waitForAgent) {
    await deps.waitForAgent(pane, WORK_DELIVERY_AGENT_START_WAIT_MS).catch(() => false)
  }
  return readFinishedTurn(deps, pane)
}

/** Nothing was sent, so a reopened pane whose agent is still starting is offered again. */
export function notSentHold(started: boolean): [WorkDeliveryHeldReason, string] {
  return started
    ? [
        'busy',
        'The reopened session had not started its agent yet, so nothing was sent; it is offered again.'
      ]
    : ['unverifiable', 'The agent in that pane could not be proven, so nothing was sent.']
}

/** The pane's last finished turn; undefined when this desktop cannot read turn identity. */
export async function readFinishedTurn(
  deps: WorkDeliveryDeps,
  pane: WorkPane
): Promise<string | null | undefined> {
  if (!deps.finishedTurn) {
    return undefined
  }
  return deps.finishedTurn(pane).catch(() => undefined)
}

/** A turn newer than the one before the handover finished, and stayed the newest for an idle gap. */
export async function turnFinishedUnseen(ledger: ClaimerLedger, watch: Watch, now: number) {
  const turn = await readFinishedTurn(ledger.deps, watch.pane)
  if (!turn || turn === watch.turnBefore) {
    watch.turnSeen = undefined
    return false
  }
  if (watch.turnSeen !== turn || watch.freeSince === null) {
    watch.turnSeen = turn
    watch.freeSince = now
    return false
  }
  return now - watch.freeSince >= WORK_DELIVERY_DONE_IDLE_GAP_MS
}

/** A turn a login failure cut off is not done: it waits for the resume (true), or is let go once held. */
export async function followLoginCut(
  ledger: ClaimerLedger,
  hostId: string,
  key: string,
  watch: Watch,
  now: number
): Promise<boolean> {
  const cut = ledger.deps.loginCut?.(watch.pane, watch.handedAt) ?? null
  if (!cut) {
    // Newer work ran in the conversation (superseded), or the resume moved it to another pane.
    if (watch.loginCut === 'cut_off') {
      watch.loginCut = null
    }
    return false
  }
  if (cut.state !== watch.loginCut) {
    watch.loginCut = cut.state
    watch.phase = 'working'
    watch.since = now
    watch.freeSince = null
    if (cut.paneKey !== watch.pane.paneKey) {
      watch.pane = {
        ...watch.pane,
        paneKey: cut.paneKey,
        worktreeId: cut.worktreeId ?? watch.pane.worktreeId
      }
    }
    await ledger.receipt(hostId, watch.delivery, {
      state: 'working',
      detail: { loginCut: cut.state }
    })
    ledger.deps.audit(
      watch.delivery,
      `login failure cut off its turn: ${cut.state} (pane ${cut.paneKey})`
    )
  }
  if (cut.state === 'held') {
    ledger.watching.delete(key)
  }
  return cut.state !== 'resumed'
}

export async function followWorking(
  ledger: ClaimerLedger,
  hostId: string,
  key: string,
  watch: Watch,
  now: number
) {
  if (now - watch.since > WORK_DELIVERY_DONE_FOLLOW_MS) {
    ledger.watching.delete(key)
    return
  }
  const busy = await ledger.deps.busy(watch.pane)
  if (busy !== false) {
    watch.freeSince = null
    return
  }
  if (watch.freeSince === null) {
    watch.freeSince = now
    return
  }
  if (now - watch.freeSince >= WORK_DELIVERY_DONE_IDLE_GAP_MS) {
    ledger.watching.delete(key)
    await ledger.receipt(hostId, watch.delivery, { state: 'done' })
    ledger.deps.audit(watch.delivery, `done in pane ${watch.pane.paneKey}`)
  }
}
