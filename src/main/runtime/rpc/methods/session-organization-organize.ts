// `sessionOrganization.organize` — `omni session organize|tag|hide|unhide|snooze`: an agent
// organizes the Conversations sidebar in bulk through the one recorded change path. Local CLI
// only, like `sessionFolders.*`; the acting session is proven by its pane evidence.

import type {
  SessionFolderListResult,
  SessionFolderMutationResult
} from '../../../../shared/session-folder-cli'
import {
  SESSION_ORGANIZE_RPC,
  SessionOrganizeParamsSchema,
  type SessionOrganizeResult
} from '../../../../shared/session-organize'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import { auditActor } from '../../../session-manage/session-actions-log'
import { observeSessionManageRows } from '../../../session-manage/session-manage-inventory'
import { readSidebarRows } from '../../../session-manage/session-manage-runtime-actions'
import { createRuntimeObserveSources } from '../../../session-manage/session-manage-runtime-sources'
import { assertUnattendedPolicy } from '../../../session-manage/session-manage-unattended'
import { sessionOrganizationLedgerFor } from '../../../session-organization/organization-change-ledger'
import { organizeSessions } from '../../../session-organization/organization-organize'
import { executorForActor } from '../../../session-organization/organization-relayed-mutation'
import { defineMethod } from '../core'
import { assertLocalSessionFolderCaller, mutateSessionFolders } from './session-folders'
import { actorFor } from './session-manage-support'

export const SESSION_ORGANIZE_METHOD = defineMethod({
  name: SESSION_ORGANIZE_RPC,
  params: SessionOrganizeParamsSchema,
  handler: async (params, context): Promise<SessionOrganizeResult> => {
    assertLocalSessionFolderCaller(context)
    const sidebar = await readSidebarRows(context.runtime)
    const actor = actorFor(context, sidebar)
    if (params.apply === true) {
      assertUnattendedPolicy(actor, 'organize')
    }
    const { plan } = params
    return organizeSessions(
      {
        plan,
        apply: params.apply === true,
        executor: executorForActor(actor),
        actor,
        audit: auditActor(actor)
      },
      {
        readRows: async () =>
          (
            await observeSessionManageRows(
              sidebar.filter((row) => row.paneKey !== null),
              createRuntimeObserveSources(context.runtime)
            )
          ).map(({ row, entry }) => ({ row, state: entry.state })),
        listFolders: async () =>
          (
            (await context.runtime.requestSessionFolders({
              kind: 'list'
            })) as SessionFolderListResult
          ).folders,
        mutateFolder: (op) =>
          mutateSessionFolders(context, {
            op,
            ...(plan.reason ? { reason: plan.reason } : {}),
            ...(plan.request ? { request: plan.request } : {})
          }) as Promise<SessionFolderMutationResult>,
        ledger: sessionOrganizationLedgerFor(getProfileUserDataPath()),
        relay: (request) => context.runtime.requestSessionFolders(request)
      }
    )
  }
})
