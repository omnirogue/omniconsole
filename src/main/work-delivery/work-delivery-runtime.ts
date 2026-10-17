/**
 * The real dependencies behind the work-delivery claimer: this runtime's rows and verdicts, the
 * organization ledger (unarchive), `resumeConversation` (same conversation, same account), the
 * prompt queue (bound to the proven agent process), and the one fresh session
 * (work-delivery-respawn.ts).
 */

import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import { normalizeLaunchCause } from '../../shared/launch-cause'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import { parseSessionReference, rowsForSessionReference } from '../../shared/session-reference'
import { runtimeReviewRowReader } from '../artifacts/artifact-review-wake-runtime'
import { observeConversationReadiness } from '../runtime/conversation-readiness'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { readPaneAgentPresence } from '../runtime/prompt-queue-agent-presence'
import { enqueueConversationPrompt } from '../runtime/prompt-queue-enqueue'
import { bindSessionPrompt } from '../runtime/session-prompt-binding'
import { activeRuntimeSessionHost } from '../session-host/session-host-runtime'
import { sessionActionsLogFor } from '../session-manage/session-actions-log'
import { resumeConversation } from '../session-manage/session-manage-resume'
import { runtimeResumeDeps } from '../session-manage/session-manage-resume-runtime'
import { SessionManageRefusal } from '../session-manage/session-manage-refusal'
import { sessionOrganizationLedgerFor } from '../session-organization/organization-change-ledger'
import { relayOrganizationMutation } from '../session-organization/organization-relayed-mutation'
import type { WorkDeliveryApi } from './work-delivery-api'
import {
  queueEntryState,
  WorkDeliveryHold,
  type QueueEntryState,
  type WorkDeliveryDeps,
  type WorkHolder,
  type WorkPane
} from './work-delivery-claimer'
import type { WorkDeliveryKind, WorkDeliveryKindAdapter } from './work-delivery-kind'
import { isParkedPane, restartParkedPane } from './work-delivery-parked'
import { respawnFreshSession } from './work-delivery-respawn'

const ACTOR = 'work-delivery' as const
const AGENT_POLL_MS = 500

const paneOf = (row: SessionManageSidebarRow): WorkPane => ({
  paneKey: row.paneKey!,
  worktreeId: row.worktreeId,
  tabId: row.tabId,
  archived: row.archived,
  title: row.title
})

const sourceOf = (pane: WorkPane): ConversationSource => ({
  kind: 'pty',
  worktreeId: pane.worktreeId,
  paneKey: pane.paneKey
})

/** The refusal words `resumeConversation` uses, as the held reasons OmniOS records. */
export function resumeRefusalReason(message: string): WorkDeliveryHold['reason'] {
  if (/No transcript .* was found|source missing/.test(message)) {
    return 'transcript_gone'
  }
  if (
    /The person (deleted|hid) this conversation|could not say whether the person deleted/.test(
      message
    )
  ) {
    return 'protection'
  }
  if (
    /cannot be verified|never opened a second time|held by \d+ sidebar rows|ambiguous/.test(message)
  ) {
    return 'unverifiable'
  }
  if (/not a workspace OmniConsole has open/.test(message)) {
    return 'not_found'
  }
  return 'error'
}

export function runtimeWorkDeliveryDeps(input: {
  runtime: OrcaRuntimeService
  userDataPath: string
  api: WorkDeliveryApi
  hostLabel: string
  adapters: ReadonlyMap<WorkDeliveryKind, WorkDeliveryKindAdapter>
}): WorkDeliveryDeps {
  const { runtime, userDataPath } = input
  const { readRows, observe, windowAttached } = runtimeReviewRowReader(runtime)
  /** Its owner's pane slept before this app restarted: the window restarts it in place. */
  const parked = new Map<string, SessionManageSidebarRow>()
  // Why folded rows too: a conversation resumed in a new pane is listed once, under its old pane.
  const paneRows = async () => (await readRows()).filter((row) => row.paneKey !== null)
  const paneByKey = async (paneKey: string | null): Promise<WorkPane> => {
    const row = paneKey
      ? (await paneRows()).find((candidate) => candidate.paneKey === paneKey)
      : undefined
    if (!row) {
      // Started, but not listed yet: a second copy is never started for it.
      throw new Error(
        `It was reopened in pane ${paneKey ?? '(unknown)'}, which this computer does not list yet.`
      )
    }
    return paneOf(row)
  }
  const unarchiveTarget = async (
    target: { paneKey: string | null; tabId: string | null },
    reason: string
  ) => {
    await relayOrganizationMutation(
      sessionOrganizationLedgerFor(userDataPath),
      (request) => runtime.requestSessionFolders(request),
      {
        op: {
          kind: 'archiveSession',
          ...(target.paneKey ? { paneKey: target.paneKey } : {}),
          ...(target.tabId ? { tabId: target.tabId } : {}),
          archived: false
        },
        executor: { kind: 'app', feature: 'work-delivery' },
        reason,
        actor: { actor: ACTOR }
      }
    )
  }
  return {
    api: input.api,
    adapters: input.adapters,
    hostLabel: input.hostLabel,
    hostId: () => activeRuntimeSessionHost()?.current()?.identity.hostId ?? null,
    resolveTarget: (adapter, delivery) => adapter.resolve(delivery, runtime),
    windowAttached,
    findHolder: async (target): Promise<WorkHolder> => {
      const reference = parseSessionReference(target.ref)
      if (!reference) {
        return { kind: 'blocked', reason: `${target.ref} is not a session reference.` }
      }
      const rows = await paneRows()
      const own = target.paneKey ? rows.find((row) => row.paneKey === target.paneKey) : undefined
      const holders = rowsForSessionReference(reference, rows)
      let blocked: string | null = null
      parked.delete(target.ref)
      // Why its own pane first: that is where the owner bound it.
      const ordered =
        own && holders.includes(own) ? [own, ...holders.filter((row) => row !== own)] : holders
      for (const row of ordered) {
        const entry = await observe(row)
        if (entry.verdict === 'live' && entry.state !== 'unknown') {
          const presence = await readPaneAgentPresence(runtime, sourceOf(paneOf(row))).catch(
            () => null
          )
          if (!presence || presence.kind === 'proven' || presence.kind === 'unverifiable') {
            return { kind: 'live', pane: paneOf(row) }
          }
          if (row === own) {
            parked.set(target.ref, row)
          }
          continue
        }
        if (row === own && isParkedPane(runtime, row, entry)) {
          parked.set(target.ref, row)
        } else if (entry.verdict !== 'exited') {
          // Loss of contact is never evidence of an exit; a second copy is never started.
          blocked ??= `“${entry.title}” cannot be verified, so it is not woken a second time.`
        }
      }
      return blocked ? { kind: 'blocked', reason: blocked } : { kind: 'none' }
    },
    unarchive: (pane, reason) => unarchiveTarget(pane, reason),
    resume: async (target, reason) => {
      const sleptPane = parked.get(target.ref)
      if (sleptPane) {
        parked.delete(target.ref)
        await restartParkedPane(runtime, sleptPane)
        return paneByKey(sleptPane.paneKey)
      }
      try {
        const resumed = await resumeConversation(
          runtimeResumeDeps(runtime, {
            userDataPath,
            launchCause: normalizeLaunchCause({
              trigger: 'hibernation-wake',
              actor: { kind: 'app' }
            }),
            ...(target.model || target.effort
              ? {
                  launchPreferences: {
                    ...(target.model ? { model: target.model } : {}),
                    ...(target.effort ? { effort: target.effort } : {})
                  }
                }
              : {}),
            unarchive: { feature: 'work-delivery', actor: ACTOR, reason }
          }),
          { actor: { kind: 'steward', feature: 'rules' }, ref: target.ref, dryRun: false }
        )
        return await paneByKey('paneKey' in resumed ? (resumed.paneKey ?? null) : null)
      } catch (error) {
        if (error instanceof SessionManageRefusal) {
          throw new WorkDeliveryHold(resumeRefusalReason(error.message), error.message)
        }
        throw error
      }
    },
    respawn: (delivery, target, brief, operationId) =>
      respawnFreshSession(runtime, delivery, target, brief, operationId),
    enqueue: async (pane, _target, id, text) => {
      const source = sourceOf(pane)
      const presence = await readPaneAgentPresence(runtime, source)
      if (presence.kind !== 'proven') {
        return false
      }
      const rowKey = conversationSourceRowKey(source)
      const earlier = runtime.readPromptQueue(rowKey)?.entries.find((entry) => entry.id === id)
      // Why: the queue keeps one entry per id, so an attempt proven unsent is cleared to go again.
      if (earlier?.state === 'failed' && earlier.unsent) {
        runtime.removePromptQueueEntry(rowKey, id)
      }
      bindSessionPrompt(rowKey, id, {
        receiver: presence.proof
      })
      enqueueConversationPrompt(runtime, source, {
        id,
        text,
        requestedBy: { action: 'continue', actor: ACTOR }
      })
      return true
    },
    queueState: (pane, id): QueueEntryState =>
      queueEntryState(
        runtime
          .readPromptQueue(conversationSourceRowKey(sourceOf(pane)))
          ?.entries.find((e) => e.id === id)
      ),
    busy: async (pane) => {
      const readiness = await observeConversationReadiness(runtime, sourceOf(pane)).catch(
        () => null
      )
      if (!readiness || readiness.unverifiable) {
        return null
      }
      return !readiness.free
    },
    finishedTurn: async (pane) => {
      const readiness = await observeConversationReadiness(runtime, sourceOf(pane)).catch(
        () => null
      )
      return readiness?.ready && readiness.version ? readiness.version : null
    },
    waitForAgent: async (pane, waitMs) => {
      const deadline = Date.now() + waitMs
      for (;;) {
        const presence = await readPaneAgentPresence(runtime, sourceOf(pane)).catch(() => null)
        if (presence?.kind === 'proven') {
          return true
        }
        if (Date.now() >= deadline) {
          return false
        }
        await new Promise((resolve) => setTimeout(resolve, AGENT_POLL_MS))
      }
    },
    audit: (delivery, summary) => {
      void sessionActionsLogFor(userDataPath)
        .append({
          actor: ACTOR,
          action: 'resume',
          target: { paneKey: delivery.owner?.paneKey ?? null },
          summary,
          workDelivery: { key: delivery.key, workItem: delivery.workItem }
        })
        .catch(() => {})
    },
    deliverLive: (adapter, delivery, target) =>
      adapter.deliverLive
        ? adapter.deliverLive(delivery, target, runtime)
        : Promise.resolve('not_open' as const),
    restoreDeleted: async (adapter, delivery, target) => {
      if (!adapter.restoreDeleted) {
        throw new Error('This kind of work cannot bring back a deleted conversation.')
      }
      await adapter.restoreDeleted(delivery, target, runtime)
    },
    now: () => Date.now()
  }
}
