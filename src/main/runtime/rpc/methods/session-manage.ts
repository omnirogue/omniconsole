// `sessionManage.*` — one conversation managing the others on this computer, when the person asks
// it (`omni session list|stop|restart|rename|conflicts|tidy|show`; `continue` and `ask` are in
// session-manage-delivery-methods.ts, `find-owner` and `assign` in
// session-manage-owner-methods.ts). Local CLI only: a paired device, another computer or a
// dispatch capability is refused before anything is read. The person-only decision methods
// (`promptQueue.enqueue`, `nextSteps.decide`, `nextSteps.keepGoing`) are unchanged.

import { SESSION_MANAGE_RPC } from '../../../../shared/session-manage-types'
import { assertSessionManageCaller } from '../../../session-manage/session-manage-caller'
import { findSessionConflicts } from '../../../session-manage/session-manage-conflicts'
import {
  renameSession,
  restartSession,
  stopSession
} from '../../../session-manage/session-manage-control'
import {
  listSessionManageEntries,
  observeSessionManageRows
} from '../../../session-manage/session-manage-inventory'
import {
  readSidebarRows,
  runtimeControlDeps,
  runtimeReadChangedFiles
} from '../../../session-manage/session-manage-runtime-actions'
import { createRuntimeObserveSources } from '../../../session-manage/session-manage-runtime-sources'
import { withRuntimeWorkflowRuns } from '../../../session-manage/session-manage-workflow-runtime'
import { listBackgroundSessionManageEntries } from '../../../session-manage/session-manage-background-terminals'
import { readSessionParityPopulation } from '../../../session-manage/session-parity-read'
import { assertUnattendedPolicy } from '../../../session-manage/session-manage-unattended'
import { defineMethod, type RpcMethod } from '../core'
import { SESSION_MANAGE_TRANSFER_METHODS } from './session-manage-transfer-methods'
import { remoteSessionAction } from './session-manage-remote'
import { SESSION_MANAGE_DELIVERY_METHODS } from './session-manage-delivery-methods'
import { SESSION_MANAGE_ANSWER_METHOD } from './session-manage-answer-method'
import { SESSION_MANAGE_TIDY_METHOD } from './session-manage-tidy-method'
import { SESSION_MANAGE_SHOW_METHOD } from './session-manage-show-method'
import { SESSION_MANAGE_OWNER_METHODS } from './session-manage-owner-methods'
import {
  SessionManageListParams,
  SessionManageRenameParams,
  SessionManageRestartParams,
  SessionManageStopParams
} from './session-manage-schemas'
import {
  folderFilterId,
  prepareSessionAction,
  projectFilter,
  settleSessionAction,
  withPartialAudit
} from './session-manage-support'
import type { OrganizationRelayedChange } from '../../../../shared/session-organization-change'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import { auditActor } from '../../../session-manage/session-actions-log'
import { sessionOrganizationLedgerFor } from '../../../session-organization/organization-change-ledger'
import { executorForActor } from '../../../session-organization/organization-relayed-mutation'
import { recordTitleRename } from '../../../session-organization/organization-title-rename'

export const SESSION_MANAGE_METHODS: RpcMethod[] = [
  SESSION_MANAGE_ANSWER_METHOD,
  defineMethod({
    name: SESSION_MANAGE_RPC.list,
    params: SessionManageListParams,
    handler: async (params, context) => {
      assertSessionManageCaller(context)
      const project = params.project ? await projectFilter(context, params.project) : undefined
      const rows = await readSidebarRows(
        context.runtime,
        project ? { projectFolderId: project.folderId } : {}
      )
      const folderId = params.folder ? await folderFilterId(context, params.folder) : undefined
      // Why the controller reader: a workflow row lists its run's state as its controller has it.
      const sources = withRuntimeWorkflowRuns(
        createRuntimeObserveSources(context.runtime),
        context.runtime
      )
      const filter = {
        ...(params.hostId ? { hostId: params.hostId } : {}),
        ...(params.query ? { query: params.query } : {}),
        ...(params.states ? { states: params.states } : {}),
        ...(folderId !== undefined ? { folderId } : {}),
        ...(project ? { projectThreads: true } : {}),
        includeArchived: params.includeArchived === true
      }
      const background = context.runtime.listBackgroundRuntimeOwnedTerminals()
      // Session parity (C5): the unfiltered population, whatever the filters above narrow — only
      // for a caller that asked (`omni session list`), never for the CLI's internal resolvers.
      const parity =
        params.parity === true ? await readSessionParityPopulation(context.runtime) : null
      return {
        sessions: [
          ...(await listSessionManageEntries(rows, sources, filter)),
          // Why: a process an earlier click started must stay visible, never silently running.
          ...(await listBackgroundSessionManageEntries(background, rows, sources, filter))
        ],
        scope: {
          source: 'controller-sidebar',
          backgroundTerminals: background ? 'listed' : 'unavailable',
          includeArchived: params.includeArchived === true,
          ...(params.hostId ? { hostId: params.hostId } : {}),
          ...(params.query ? { query: params.query } : {}),
          ...(project ? { project } : {})
        },
        ...(parity ? { parity } : {})
      }
    }
  }),
  defineMethod({
    name: SESSION_MANAGE_RPC.stop,
    params: SessionManageStopParams,
    handler: async (params, context) => {
      const prepared = await prepareSessionAction(context, params.target)
      const remote = await remoteSessionAction(
        context,
        prepared,
        { action: 'stop', payload: params.force === true ? { force: true } : {} },
        params
      )
      if (remote) {
        return remote
      }
      const result = await withPartialAudit(context, prepared, 'stop', params, () =>
        stopSession(runtimeControlDeps(context.runtime), {
          actor: prepared.actor,
          target: prepared,
          force: params.force === true,
          dryRun: params.dryRun === true
        })
      )
      return settleSessionAction(context, prepared, 'stop', result, params, {
        before: { state: prepared.entry.state, keepGoing: prepared.entry.keepGoing }
      })
    }
  }),
  defineMethod({
    name: SESSION_MANAGE_RPC.restart,
    params: SessionManageRestartParams,
    handler: async (params, context) => {
      const prepared = await prepareSessionAction(context, params.target)
      const remote = await remoteSessionAction(
        context,
        prepared,
        { action: 'restart', payload: {} },
        params
      )
      if (remote) {
        return remote
      }
      const result = await withPartialAudit(context, prepared, 'restart', params, () =>
        restartSession(runtimeControlDeps(context.runtime), {
          actor: prepared.actor,
          target: prepared,
          dryRun: params.dryRun === true
        })
      )
      return settleSessionAction(context, prepared, 'restart', result, params, {
        before: { verdict: prepared.entry.verdict, state: prepared.entry.state },
        windowToastShown: prepared.entry.verdict === 'exited'
      })
    }
  }),
  defineMethod({
    name: SESSION_MANAGE_RPC.rename,
    params: SessionManageRenameParams,
    handler: async (params, context) => {
      const prepared = await prepareSessionAction(context, params.target)
      // Why before the record: a refused steward rename leaves no prepared change behind.
      assertUnattendedPolicy(prepared.actor, 'rename')
      const rename = (change?: OrganizationRelayedChange) =>
        renameSession(runtimeControlDeps(context.runtime), {
          actor: prepared.actor,
          target: prepared,
          title: params.title,
          dryRun: params.dryRun === true,
          ...(change ? { change } : {})
        })
      if (params.dryRun === true) {
        const { before: _before, after: _after, ...result } = await rename()
        return result
      }
      // Why the ledger: its trail line is the audit line, with who chose the title's words.
      const {
        before: _before,
        after: _after,
        organization: _organization,
        ...result
      } = await recordTitleRename(
        sessionOrganizationLedgerFor(getProfileUserDataPath()),
        {
          row: prepared.row,
          title: params.title,
          executor: executorForActor(prepared.actor),
          ...(params.origin ? { origin: params.origin } : {}),
          ...(params.reason ? { reason: params.reason } : {}),
          ...(params.request ? { request: params.request } : {}),
          actor: auditActor(prepared.actor)
        },
        rename
      )
      return result
    }
  }),
  defineMethod({
    name: SESSION_MANAGE_RPC.conflicts,
    params: null,
    handler: async (_params, context) => {
      assertSessionManageCaller(context)
      const rows = await readSidebarRows(context.runtime)
      const observed = await observeSessionManageRows(
        rows,
        createRuntimeObserveSources(context.runtime)
      )
      return findSessionConflicts(
        observed.filter(({ entry }) => entry.verdict === 'live'),
        runtimeReadChangedFiles(context.runtime)
      )
    }
  }),
  SESSION_MANAGE_TIDY_METHOD,
  SESSION_MANAGE_SHOW_METHOD,
  ...SESSION_MANAGE_OWNER_METHODS,
  ...SESSION_MANAGE_TRANSFER_METHODS,
  ...SESSION_MANAGE_DELIVERY_METHODS
]
