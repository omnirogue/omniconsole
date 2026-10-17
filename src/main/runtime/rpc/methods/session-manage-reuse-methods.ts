// `sessionManage.resume` (`omni session resume --ref`), `sessionManage.continueWhenIdle`
// (`omni session continue --prompt … --when-idle`) and `sessionManage.pending`: reusing past and
// busy work instead of launching new. Local CLI only, like every `sessionManage.*` method.

import { randomUUID } from 'node:crypto'
import {
  SESSION_WHEN_IDLE_DEFAULT_MS,
  isSessionPendingDeliverySettled,
  type SessionContinueWhenIdleResult,
  type SessionPendingListResult
} from '../../../../shared/session-pending-delivery-types'
import { promptQueueTextRefusal } from '../../../../shared/prompt-queue-types'
import {
  SESSION_MANAGE_RPC,
  sessionManageActorTitle
} from '../../../../shared/session-manage-types'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import {
  assertSessionManageCaller,
  isSelfTarget
} from '../../../session-manage/session-manage-caller'
import { continueSession } from '../../../session-manage/session-manage-continue'
import { freeformApprovalRefusal } from '../../../session-manage/session-manage-freeform'
import { remoteExecutionRefusal } from '../../../session-manage/session-manage-locality'
import {
  refuseHardStop,
  SessionManagePartialError,
  SessionManageRefusal
} from '../../../session-manage/session-manage-refusal'
import type { SessionResumeResult } from '../../../../shared/session-resume-types'
import { resumeConversation } from '../../../session-manage/session-manage-resume'
import { runtimeResumeDeps } from '../../../session-manage/session-manage-resume-runtime'
import {
  readSidebarRows,
  runtimeDeliveryDeps,
  showSessionManageNotice
} from '../../../session-manage/session-manage-runtime-actions'
import { sessionOwnerLoad } from '../../../session-manage/session-manage-owner-load'
import {
  assignSessionOnRuntime,
  runtimeChainBound
} from '../../../session-manage/session-manage-owner-runtime'
import { getSessionPendingDeliveries } from '../../../session-manage/session-pending-deliveries-runtime'
import { assertUnattendedPolicy } from '../../../session-manage/session-manage-unattended'
import { defineMethod, type RpcMethod } from '../core'
import {
  SessionManageContinueWhenIdleParams,
  SessionManagePendingParams,
  SessionManageResumeParams
} from './session-manage-reuse-schemas'
import {
  actorFor,
  prepareSessionAction,
  recordSessionAction,
  settleSessionAction,
  withPartialAudit
} from './session-manage-support'

function pendingEngine() {
  const engine = getSessionPendingDeliveries()
  if (!engine) {
    throw new Error('Held prompts are not available in this OmniConsole process. Nothing was held.')
  }
  return engine
}

function minutes(ms: number): string {
  const count = Math.round(ms / 60_000)
  return `${count} minute${count === 1 ? '' : 's'}`
}

export const SESSION_MANAGE_REUSE_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_MANAGE_RPC.resume,
    params: SessionManageResumeParams,
    handler: async (params, context): Promise<SessionResumeResult & { auditError?: string }> => {
      assertSessionManageCaller(context)
      const actor = actorFor(
        context,
        context.orchestrationCompatibilityEvidence ? await readSidebarRows(context.runtime) : []
      )
      assertUnattendedPolicy(actor, 'resume')
      const deps = runtimeResumeDeps(context.runtime, {
        userDataPath: getProfileUserDataPath(),
        ...(context.signal ? { signal: context.signal } : {})
      })
      const provenance = { reason: params.reason, request: params.request }
      try {
        const result = await resumeConversation(deps, {
          actor,
          ref: params.ref,
          dryRun: params.dryRun === true
        })
        if (result.dryRun || result.outcome === 'already-open') {
          return result
        }
        const auditError = await recordSessionAction({
          actor,
          action: 'resume',
          target: {
            paneKey: result.paneKey ?? null,
            tabId: result.tabId ?? null,
            title: params.ref
          },
          summary: result.summary,
          provenance,
          before: { ref: params.ref },
          after: {
            outcome: result.outcome,
            ...(result.terminal ? { terminal: result.terminal } : {}),
            ...(result.cwd ? { cwd: result.cwd } : {}),
            ...(result.profile ? { profile: result.profile.path } : {})
          }
        })
        // The window already names a checkpoint resume in its own toast.
        if (result.outcome !== 'restarted') {
          showSessionManageNotice(context.runtime, { kind: 'notice', summary: result.summary })
        }
        return auditError ? { ...result, auditError } : result
      } catch (error) {
        if (error instanceof SessionManagePartialError) {
          await recordSessionAction({
            actor,
            action: 'resume',
            target: { paneKey: null, tabId: null, title: params.ref },
            summary: `Partly applied: ${error.message}`,
            provenance,
            after: { applied: error.applied, completed: false }
          })
          showSessionManageNotice(context.runtime, { kind: 'notice', summary: error.message })
        }
        throw error
      }
    }
  }),
  defineMethod({
    name: SESSION_MANAGE_RPC.continueWhenIdle,
    params: SessionManageContinueWhenIdleParams,
    handler: async (params, context): Promise<SessionContinueWhenIdleResult> => {
      const engine = pendingEngine()
      const prepared = await prepareSessionAction(context, params.target)
      const { actor, entry } = prepared
      assertUnattendedPolicy(actor, 'hold')
      const name = `“${entry.title}”`
      if (!entry.paneKey || isSelfTarget(actor, entry.paneKey)) {
        throw new SessionManageRefusal(
          `${entry.paneKey ? 'That is the session running this command' : `${name} has no pane yet`}, so nothing was held.`
        )
      }
      const remote = remoteExecutionRefusal(entry, 'continue')
      if (remote) {
        throw new SessionManageRefusal(remote)
      }
      if (entry.verdict === 'exited') {
        throw new SessionManageRefusal(
          `${name} has exited, so nothing was held. Resume it first: omni session restart --pane ${entry.paneKey}`
        )
      }
      // The text never changes while it waits: its own checks run now, once.
      refuseHardStop(params.text, entry)
      const textRefusal =
        freeformApprovalRefusal(params.text) ?? promptQueueTextRefusal(params.text)
      if (textRefusal) {
        throw new SessionManageRefusal(textRefusal)
      }
      const dryRun = params.dryRun === true
      const assign = params.kind === 'assign'
      const action = assign ? ('assign' as const) : ('continue' as const)
      const load = sessionOwnerLoad(entry, runtimeChainBound(context.runtime, prepared.row))
      let words = load.words
      if (load.light) {
        try {
          const { result, entryId } = await withPartialAudit(
            context,
            prepared,
            action,
            params,
            () =>
              assign
                ? assignSessionOnRuntime(context.runtime, {
                    actor,
                    target: prepared,
                    task: params.text,
                    dryRun
                  })
                : continueSession(runtimeDeliveryDeps(context.runtime), {
                    actor,
                    target: prepared,
                    answer: { kind: 'prompt', text: params.text },
                    dryRun
                  })
          )
          const settled = await settleSessionAction(context, prepared, action, result, params, {
            before: { state: entry.state, keepGoing: entry.keepGoing },
            after: { queued: result.sent, keepGoing: false },
            ...(entryId ? { undoEntryId: entryId, source: prepared.source } : {})
          })
          return { ...settled, delivered: !dryRun }
        } catch (error) {
          // Free, but its latest reply is not open to a new prompt: hold it for the next turn.
          if (!(error instanceof SessionManageRefusal)) {
            throw error
          }
          words = error.message
        }
      }
      const withinMs = params.withinMs ?? SESSION_WHEN_IDLE_DEFAULT_MS
      const from = sessionManageActorTitle(actor)
      const what = assign ? 'task' : 'prompt'
      const base = {
        dryRun,
        action,
        target: { paneKey: entry.paneKey, title: entry.title },
        actor
      }
      if (dryRun) {
        return {
          ...base,
          summary: `Would hold the ${what} from ${from} for ${name} and send it the moment it is free, within ${minutes(withinMs)}; now: ${words} (dry run: nothing changed).`
        }
      }
      const now = Date.now()
      const pending = await engine.hold({
        id: `held-${randomUUID()}`,
        createdAt: now,
        expiresAt: now + withinMs,
        actor,
        target: { paneKey: entry.paneKey, tabId: entry.tabId, title: entry.title },
        ...(assign ? { kind: 'assign' as const } : {}),
        text: params.text,
        ...(params.reason ? { reason: params.reason } : {}),
        ...(params.request ? { request: params.request } : {}),
        state: 'waiting',
        note: `Waiting: ${words}`
      })
      const summary = `Holding a ${what} from ${from} for ${name}: it is sent the moment ${name} is free, within ${minutes(withinMs)}. If it is not free by then, it is reported back unsent and nothing is launched elsewhere.`
      const auditError = await recordSessionAction({
        actor,
        action,
        target: { paneKey: entry.paneKey, tabId: entry.tabId, title: entry.title },
        summary,
        provenance: params,
        before: { state: entry.state },
        after: { held: pending.id, expiresAt: pending.expiresAt }
      })
      showSessionManageNotice(context.runtime, { kind: 'notice', summary })
      if (!params.wait) {
        return { ...base, pending, summary, ...(auditError ? { auditError } : {}) }
      }
      const final = await engine.waitFor(pending.id, context.signal)
      return {
        ...base,
        pending: final,
        delivered: final.state === 'delivered',
        summary: isSessionPendingDeliverySettled(final) ? (final.note ?? summary) : summary
      }
    }
  }),
  defineMethod({
    name: SESSION_MANAGE_RPC.pending,
    params: SessionManagePendingParams,
    handler: async (params, context): Promise<SessionPendingListResult> => {
      assertSessionManageCaller(context)
      const engine = pendingEngine()
      if (params.cancel) {
        return { deliveries: [await engine.cancel(params.cancel)] }
      }
      return {
        deliveries: engine
          .list()
          .filter((delivery) => params.all === true || !isSessionPendingDeliverySettled(delivery))
      }
    }
  })
]
