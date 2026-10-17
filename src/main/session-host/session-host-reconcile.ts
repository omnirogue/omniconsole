/**
 * What a host process does when it opens the registry: records itself as a live controller, and
 * settles what a controller that is PROVABLY gone left in flight. An operation it only admitted
 * provably sent nothing (dispatch is written durably before any byte moves), so it is refused and
 * its turn freed; one it had dispatched may have been delivered, so it becomes `unconfirmed` and
 * keeps blocking. A controller whose death cannot be proved is left alone: loss of contact is never
 * evidence of exit.
 */

import { parseAgentSessionOperationTimestamp } from '../../shared/agent-session-host-authority'
import { sessionHostActionConsumesTurn } from '../../shared/session-host-protocol'
import { sessionHostRefusal } from '../../shared/session-host-refusal'
import { readManagedHookProcessIdentity } from '../agent-hooks/managed-hook-owner-identity'
import type { SessionHostAdmissionStore } from './session-host-admission-store'
import type { SessionHostController, SessionHostJournal } from './session-host-journal'
import { settleSessionHostOperation } from './session-host-settlement'

export type SessionHostProcessLiveness = (
  controller: SessionHostController
) => Promise<'alive' | 'dead' | 'unknown'>

const RETAIN_SETTLED_MS = 30 * 24 * 60 * 60 * 1000
const MAX_SETTLED_OPERATIONS = 2_000

export const SESSION_HOST_RESTARTED_BEFORE_SENDING =
  'That computer restarted before this was sent. Nothing was delivered; observe it again and send a new request.'

/** This process's start identity, or null where reading it would fork PowerShell (Windows). */
export async function readSessionHostProcessIdentity(pid: number): Promise<string | null> {
  if (process.platform === 'win32') {
    return null
  }
  return (await readManagedHookProcessIdentity(pid)) ?? null
}

export const defaultSessionHostProcessLiveness: SessionHostProcessLiveness = async (controller) => {
  try {
    process.kill(controller.pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return 'dead'
    }
  }
  // Why identity, not the pid: a reused pid would otherwise read as the old process alive.
  const identity = await readSessionHostProcessIdentity(controller.pid)
  if (identity === null || controller.processIdentity === null) {
    return 'unknown'
  }
  return identity === controller.processIdentity ? 'alive' : 'dead'
}

function reconcileDeadController(
  journal: SessionHostJournal,
  incarnation: string,
  at: number
): void {
  for (const operation of Object.values(journal.operations)) {
    if (operation.controller !== incarnation) {
      continue
    }
    if (operation.state === 'admitted' && operation.kind !== 'reserve') {
      settleSessionHostOperation(
        journal,
        operation,
        {
          kind: 'not-delivered',
          refusal: sessionHostRefusal('reconciling', SESSION_HOST_RESTARTED_BEFORE_SENDING)
        },
        at
      )
    } else if (operation.state === 'dispatched') {
      settleSessionHostOperation(
        journal,
        operation,
        {
          kind: 'unconfirmed',
          detail: 'The process sending it stopped before it recorded whether it arrived.'
        },
        at
      )
    }
  }
  delete journal.controllers[incarnation]
}

/** Registers `self`, then reconciles every other controller proven dead. Liveness is read unlocked. */
export async function openSessionHostController(
  store: SessionHostAdmissionStore,
  self: SessionHostController,
  liveness: SessionHostProcessLiveness
): Promise<void> {
  const others = Object.values(store.snapshot()?.controllers ?? {}).filter(
    (controller) => controller.incarnation !== self.incarnation
  )
  const verdicts = await Promise.all(
    others.map(async (controller) => ({
      controller,
      verdict: await liveness(controller).catch(() => 'unknown' as const)
    }))
  )
  const dead = verdicts.filter((entry) => entry.verdict === 'dead').map((entry) => entry.controller)
  await store.mutate(async (journal) => {
    journal.controllers[self.incarnation] = self
    for (const controller of dead) {
      const current = journal.controllers[controller.incarnation]
      // Why re-checked: a controller re-registered since the unlocked read is not the one judged.
      if (current && current.pid === controller.pid && current.startedAt === controller.startedAt) {
        reconcileDeadController(journal, controller.incarnation, store.now())
      }
    }
    evictSettledSessionHostOperations(journal, store.now())
    return { value: undefined, changed: true }
  })
}

/**
 * Bounds the journal. Only completed or refused operations go, oldest first; the newest settled
 * reservation of each conversation stays so its consumed turn stays consumed. Every evicted id's
 * stamp raises the horizon, so a replay of it is refused rather than admitted twice.
 */
export function evictSettledSessionHostOperations(
  journal: SessionHostJournal,
  now: number
): boolean {
  const settled = Object.values(journal.operations)
    .filter((operation) => operation.state === 'completed' || operation.state === 'refused')
    .map((operation) => ({
      operation,
      stamp: parseAgentSessionOperationTimestamp(operation.operationId) ?? 0
    }))
    .sort((a, b) => a.stamp - b.stamp)
  const excess = settled.length - MAX_SETTLED_OPERATIONS
  const newestSettled = new Map<string, number>()
  for (const reservation of Object.values(journal.reservations)) {
    if (reservation.state === 'settled' && sessionHostActionConsumesTurn(reservation.action)) {
      const best = newestSettled.get(reservation.conversationId) ?? -1
      newestSettled.set(reservation.conversationId, Math.max(best, reservation.heldAt))
    }
  }
  let changed = false
  settled.forEach(({ operation, stamp }, index) => {
    if (index >= excess && now - stamp <= RETAIN_SETTLED_MS) {
      return
    }
    const reservation = journal.reservations[operation.operationId]
    if (reservation && (reservation.state === 'held' || reservation.running)) {
      return
    }
    delete journal.operations[operation.operationId]
    const keepsTurn =
      reservation?.state === 'settled' &&
      newestSettled.get(reservation.conversationId) === reservation.heldAt
    if (reservation && !keepsTurn && reservation.state !== 'dispatched') {
      delete journal.reservations[operation.operationId]
    }
    journal.horizon = Math.max(journal.horizon, stamp)
    changed = true
  })
  return changed
}
