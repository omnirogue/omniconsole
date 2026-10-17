import type { SessionManageActor } from '../../../../shared/session-manage-types'
// `sessionFolders.*` — the Conversations sidebar folders, for `omni folder …` and
// `omni session move`. The folders live in the desktop renderer's store, so each call is
// relayed to that window, which applies it through the sidebar's own store actions, shows a
// toast with Undo for every change, and answers with the result or the store's error text.
//
// Only the local socket may reorganize: a caller on a paired device (phone, remote runtime
// client) carries a client identity and is refused before anything is sent to the window.
// `dryRun` checks and describes a change without making it. Every change is recorded prepared
// before it is relayed and applied or failed after (session-organization/): an agent's move
// needs a reason, and launch filing records its own.

import type { z } from 'zod'
import {
  SESSION_FOLDERS_RPC,
  SessionFolderMutateParamsSchema,
  type SessionFolderMutationResult,
  type SessionFolderOp
} from '../../../../shared/session-folder-cli'
import {
  launchFilingReason,
  type OrganizationExecutor
} from '../../../../shared/session-organization-change'
import {
  organizationKindForFolderOp,
  requestedTargetsForFolderOp,
  requestedValueForFolderOp
} from '../../../../shared/session-organization-folder-ops'
import { agentAnswerWaitRefusal } from '../../../answer-delivery/answer-wait'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import { auditActor } from '../../../session-manage/session-actions-log'
import {
  mirroredConversationDeleteRefusal,
  sessionDeleteRefusal,
  recordOnlyMirrorDeleteRefusal
} from '../../../session-manage/session-manage-delete-guard'
import {
  describeMissingTarget,
  findSessionManageRow,
  toSessionManageEntry
} from '../../../session-manage/session-manage-inventory'
import { observeSession } from '../../../session-manage/session-manage-observe'
import { readSidebarRows } from '../../../session-manage/session-manage-runtime-actions'
import { createRuntimeObserveSources } from '../../../session-manage/session-manage-runtime-sources'
import { sessionWorkflowDeleteRefusal } from '../../../session-manage/session-manage-workflow'
import { withRuntimeWorkflowRuns } from '../../../session-manage/session-manage-workflow-runtime'
import { unattendedContextFor } from '../../../session-manage/session-manage-unattended'
import { admitUnattendedOrganization } from '../../../session-manage/session-manage-unattended-admission'
import { sessionOrganizationLedgerFor } from '../../../session-organization/organization-change-ledger'
import {
  executorForActor,
  organizationReasonRefusal,
  relayOrganizationMutation,
  type RelayedOrganizationResult
} from '../../../session-organization/organization-relayed-mutation'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { actorFor } from './session-manage-support'
import { archiveRemoteSession } from '../../../session-host-remote/remote-session-archive'
import {
  isRemoteSessionRow,
  remoteOrigin
} from '../../../session-host-remote/remote-session-manage'

export const SESSION_FOLDERS_LOCAL_ONLY_ERROR =
  'Only the omni CLI on this computer can read or reorganize the Conversations sidebar folders.'

export function assertLocalSessionFolderCaller(context: RpcContext): void {
  if (context.pairedDeviceId || context.clientId || context.clientKind) {
    throw new Error(SESSION_FOLDERS_LOCAL_ONLY_ERROR)
  }
}

export const SESSION_DELETE_UNVERIFIED_NEEDS_REQUEST =
  'session delete --unverified needs --request "<the person\'s own words>": only the person decides a session this computer cannot verify may go. Nothing changed.'

export const SESSION_DELETE_UNVERIFIED_UNATTENDED =
  'A steward run cannot delete a session this computer cannot verify. Nothing changed.'

/** Delete re-observes its target on this host first (`sessionDeleteRefusal`). */
async function assertDeletableSession(
  context: RpcContext,
  op: Extract<SessionFolderOp, { kind: 'deleteSession' }>,
  person: { request?: string; unattended: boolean }
): Promise<void> {
  if (op.unverified && person.unattended) {
    throw new Error(SESSION_DELETE_UNVERIFIED_UNATTENDED)
  }
  if (op.unverified && !person.request) {
    throw new Error(SESSION_DELETE_UNVERIFIED_NEEDS_REQUEST)
  }
  const rows = await readSidebarRows(context.runtime)
  const row = findSessionManageRow(rows, op, { tabOnly: true })
  if (!row) {
    throw new Error(describeMissingTarget(op))
  }
  // Why first: its paired owner runs and lists it, so no flag here may delete it (step 7, C4).
  if (row.mirroredConversationOwner) {
    throw new Error(mirroredConversationDeleteRefusal(row.title))
  }
  if (row.launchPending) {
    throw new Error(`“${row.title}” is still launching, so it was not deleted.`)
  }
  // Why every caller here: no CLI call proves a person; the person deletes it by hand, warned.
  const waiting = agentAnswerWaitRefusal(context.runtime.getArtifactApiOrigin(), row)
  if (waiting) {
    throw new Error(waiting)
  }
  // Why the controller reader: a workflow's run is revalidated where it is recorded (C6).
  const entry = toSessionManageEntry(
    await observeSession(
      row,
      withRuntimeWorkflowRuns(createRuntimeObserveSources(context.runtime), context.runtime)
    )
  )
  const options = { force: op.force === true, unverified: op.unverified === true }
  // Why its own rule: a workflow tab runs nothing here, so closing it stops nothing anywhere.
  const refusal = row.workflow
    ? sessionWorkflowDeleteRefusal(entry, options)
    : row.strandedMirrorRecord || row.recordOnlyMirror
      ? recordOnlyMirrorDeleteRefusal(row.title, options, row.strandedMirrorRecord === true)
      : sessionDeleteRefusal(entry, options)
  if (refusal) {
    throw new Error(refusal)
  }
}

export const SESSION_FOLDER_PURGE_IS_INTERNAL =
  'Deleting a session for good (no Recently closed entry) is only done by OmniConsole for a rejected review page. Nothing changed.'

export const SESSION_FOLDER_LAUNCH_MOVES_ONLY =
  'Only a session move can be recorded as launch filing.'

export const SESSION_FOLDER_UNATTENDED_LAUNCH =
  'A steward run cannot record a move as launch filing. Nothing changed.'

/**
 * One sidebar change, as the window's own action applies it (toast with Undo), recorded
 * prepared → applied/failed under the proven actor, or `launch` for filing a new session.
 */
export async function mutateSessionFolders(
  context: RpcContext,
  params: z.infer<typeof SessionFolderMutateParamsSchema>,
  internalActor?: SessionManageActor
): Promise<SessionFolderMutationResult & Partial<RelayedOrganizationResult>> {
  assertLocalSessionFolderCaller(context)
  const { op } = params
  if (op.kind === 'deleteSession' && op.purge) {
    // Why: a delete without Recently closed is only a review page's Reject, decided by main.
    throw new Error(SESSION_FOLDER_PURGE_IS_INTERNAL)
  }
  const dryRun = params.dryRun === true
  if (params.launch && op.kind !== 'moveSession') {
    throw new Error(SESSION_FOLDER_LAUNCH_MOVES_ONLY)
  }
  const actor =
    internalActor ??
    actorFor(
      context,
      context.orchestrationCompatibilityEvidence ? await readSidebarRows(context.runtime) : []
    )
  const unattended = unattendedContextFor(actor)
  if (unattended && params.launch) {
    throw new Error(SESSION_FOLDER_UNATTENDED_LAUNCH)
  }
  // Why before the dry run too: a steward run's plan must say what it may really do.
  const evidence = await admitUnattendedOrganization(actor, {
    kind: organizationKindForFolderOp(op),
    value: requestedValueForFolderOp(op),
    targets: requestedTargetsForFolderOp(op)
  })
  const executor: OrganizationExecutor = params.launch
    ? { kind: 'launch', source: params.launch }
    : executorForActor(actor)
  const reason = params.launch ? launchFilingReason(params.request) : params.reason
  const refusal = organizationReasonRefusal(op, executor, reason, dryRun)
  if (refusal) {
    throw new Error(refusal)
  }
  if (op.kind === 'deleteSession') {
    await assertDeletableSession(context, op, {
      ...(params.request ? { request: params.request } : {}),
      unattended: !!unattended
    })
  }
  if (op.kind === 'archiveSession') {
    const row = findSessionManageRow(await readSidebarRows(context.runtime), op)
    if (row && isRemoteSessionRow(row)) {
      const outcome = await archiveRemoteSession(
        row,
        op.archived,
        remoteOrigin(actor, params),
        dryRun
      )
      const action = op.archived ? 'archive' : 'unarchive'
      return {
        sessionKey: row.viewKey,
        ...(dryRun ? { dryRun: true as const } : {}),
        summary:
          outcome.kind === 'would'
            ? `Would ${action} “${row.title}” on its owning computer.`
            : outcome.kind === 'completed'
              ? `The owning computer confirmed ${action} of “${row.title}”.`
              : `The owning computer has not confirmed ${action} of “${row.title}” (operation ${outcome.operationId}). Nothing is resent.`
      }
    }
  }
  if (dryRun) {
    return (await context.runtime.requestSessionFolders({
      kind: 'mutate',
      op,
      dryRun: true
    })) as SessionFolderMutationResult
  }
  return relayOrganizationMutation(
    sessionOrganizationLedgerFor(getProfileUserDataPath()),
    (request) => context.runtime.requestSessionFolders(request),
    {
      op,
      executor,
      ...(params.opId ? { opId: params.opId } : {}),
      ...(reason ? { reason } : {}),
      // Why not for a steward run: no person's words asked for it, whatever it passes.
      ...(params.request && !unattended ? { request: params.request } : {}),
      ...(evidence ? { evidence } : {}),
      ...(params.origin ? { origin: params.origin } : {}),
      ...(params.expectedRevision ? { expectedRevision: params.expectedRevision } : {}),
      actor: auditActor(actor)
    }
  )
}

export const SESSION_FOLDER_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_FOLDERS_RPC.list,
    params: null,
    handler: async (_params, context) => {
      assertLocalSessionFolderCaller(context)
      return context.runtime.requestSessionFolders({ kind: 'list' })
    }
  }),
  defineMethod({
    name: SESSION_FOLDERS_RPC.mutate,
    params: SessionFolderMutateParamsSchema,
    handler: (params, context) => mutateSessionFolders(context, params)
  })
]
