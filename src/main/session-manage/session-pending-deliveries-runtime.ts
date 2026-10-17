/**
 * The running half of held prompts: the store under this profile, a finished turn on a target as
 * the moment to try, and a slow sweep for expiry and for idle read from screens or titles. Nothing
 * runs while no prompt is held.
 */

import { sessionManageActorTitle } from '../../shared/session-manage-types'
import type { SessionPendingDelivery } from '../../shared/session-pending-delivery-types'
import { onNextStepTurnSignal } from '../next-steps/next-step-suggestion-slot'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { sessionActionsLogFor, auditActor } from './session-actions-log'
import { continueSession } from './session-manage-continue'
import { findSessionManageRow, toSessionManageEntry } from './session-manage-inventory'
import { observeSession } from './session-manage-observe'
import { SessionManageRefusal } from './session-manage-refusal'
import {
  readSidebarRows,
  runtimeDeliveryDeps,
  showSessionManageNotice
} from './session-manage-runtime-actions'
import { createRuntimeObserveSources } from './session-manage-runtime-sources'
import { assignSessionOnRuntime, runtimeChainBound } from './session-manage-owner-runtime'
import { SessionPendingDeliveries } from './session-pending-deliveries'
import { createSessionPendingDeliveriesStore } from './session-pending-deliveries-store'

const SWEEP_MS = 20_000
/** A finished turn's own next steps are read first; the prompt is tried after they settle. */
const TURN_SETTLE_MS = 2_500

let active: SessionPendingDeliveries | null = null

export function getSessionPendingDeliveries(): SessionPendingDeliveries | null {
  return active
}

async function observeTarget(
  runtime: OrcaRuntimeService,
  target: SessionPendingDelivery['target']
) {
  const row = findSessionManageRow(await readSidebarRows(runtime), {
    paneKey: target.paneKey,
    ...(target.tabId ? { tabId: target.tabId } : {})
  })
  return row ? observeSession(row, createRuntimeObserveSources(runtime)) : null
}

function report(
  runtime: OrcaRuntimeService,
  userDataPath: string,
  delivery: SessionPendingDelivery
): void {
  const summary =
    delivery.note ?? `The prompt held for “${delivery.target.title}” is ${delivery.state}.`
  void sessionActionsLogFor(userDataPath)
    .append({
      ...auditActor(delivery.actor),
      action: delivery.kind === 'assign' ? 'assign' : 'continue',
      target: {
        paneKey: delivery.target.paneKey,
        tabId: delivery.target.tabId,
        title: delivery.target.title
      },
      before: { held: delivery.id },
      after: { state: delivery.state, ...(delivery.entryId ? { entryId: delivery.entryId } : {}) },
      summary,
      ...(delivery.reason ? { reason: delivery.reason } : {}),
      ...(delivery.request ? { request: delivery.request } : {})
    })
    .catch(() => {})
  showSessionManageNotice(runtime, { kind: 'notice', summary })
}

export function startSessionPendingDeliveries(args: {
  runtime: OrcaRuntimeService
  userDataPath: string
}): () => void {
  const { runtime, userDataPath } = args
  const engine = new SessionPendingDeliveries({
    store: createSessionPendingDeliveriesStore(userDataPath),
    observe: async (target) => {
      const observed = await observeTarget(runtime, target)
      return observed
        ? { entry: toSessionManageEntry(observed), bound: runtimeChainBound(runtime, observed.row) }
        : null
    },
    deliver: async (delivery) => {
      const observed = await observeTarget(runtime, delivery.target)
      if (!observed) {
        throw new SessionManageRefusal(`No sidebar row holds pane ${delivery.target.paneKey}.`)
      }
      const target = {
        entry: toSessionManageEntry(observed),
        source: observed.source,
        agentProcess: observed.agentProcess,
        row: observed.row
      }
      const { entryId } =
        delivery.kind === 'assign'
          ? await assignSessionOnRuntime(runtime, {
              actor: delivery.actor,
              target,
              task: delivery.text,
              dryRun: false
            })
          : await continueSession(runtimeDeliveryDeps(runtime), {
              actor: delivery.actor,
              target,
              answer: { kind: 'prompt', text: delivery.text },
              dryRun: false
            })
      const what = delivery.kind === 'assign' ? 'task' : 'prompt'
      return {
        ...(entryId ? { entryId } : {}),
        summary: `Sent the ${what} from ${sessionManageActorTitle(delivery.actor)} that was held for “${delivery.target.title}”, now that it is free.`
      }
    },
    report: (delivery) => report(runtime, userDataPath, delivery),
    now: Date.now
  })
  active = engine
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  const stopTurns = onNextStepTurnSignal((signal) => {
    if (signal.kind !== 'finished' || !engine.hasWaiting()) {
      return
    }
    const timer = setTimeout(() => {
      pendingTimers.delete(timer)
      void engine.noteTurnFinished(signal.turn.conversation.paneKey)
    }, TURN_SETTLE_MS)
    pendingTimers.add(timer)
  })
  const sweep = setInterval(() => {
    if (engine.hasWaiting()) {
      void engine.sweep()
    }
  }, SWEEP_MS)
  sweep.unref?.()
  void engine.start().catch((error: unknown) => {
    console.warn('[session-pending] could not load held prompts', error)
  })
  return () => {
    stopTurns()
    clearInterval(sweep)
    for (const timer of pendingTimers) {
      clearTimeout(timer)
    }
    if (active === engine) {
      active = null
    }
  }
}
