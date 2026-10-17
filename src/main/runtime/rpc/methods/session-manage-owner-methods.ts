// `sessionManage.findOwner` / `sessionManage.assign` — `omni session find-owner|assign`: before
// launching a new session, find a free related one and give it the task (the audit line and toast
// are `continue`'s; the delivery is `continue --prompt`'s).

import type { SessionManageSidebarRow } from '../../../../shared/session-manage-relay'
import {
  SESSION_MANAGE_RPC,
  type SessionManageActor
} from '../../../../shared/session-manage-types'
import type { SessionFindOwnerResult } from '../../../../shared/session-owner-types'
import { assertSessionManageCaller } from '../../../session-manage/session-manage-caller'
import {
  sessionOwnerProjectId,
  type SessionOwnerScope
} from '../../../session-manage/session-manage-owner'
import { findSessionOwnerOnRuntime } from '../../../session-manage/session-manage-owner-runtime'
import { createSessionOwnerTimingRecorder } from '../../../session-manage/session-manage-owner-timing'
import { readSidebarRows } from '../../../session-manage/session-manage-runtime-actions'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { SessionManageAssignParams, SessionManageFindOwnerParams } from './session-manage-schemas'
import { actorFor, folderFilterId } from './session-manage-support'
import { assignByRefOnRuntime, assignOnPane } from './session-manage-assign-ref-method'

// Why: a repository other computers share lets a launch recommend `session launch --project`.
function withSessionOwnerProject(context: RpcContext, scope: SessionOwnerScope): SessionOwnerScope {
  const repo = scope.repoId
    ? context.runtime.listRepos().find((entry) => entry.id === scope.repoId)
    : undefined
  const projectId = sessionOwnerProjectId(repo)
  return projectId ? { ...scope, projectId } : scope
}

/**
 * Where the task would run: `--folder`/`--repo` when given; otherwise the asking session's own
 * workspace, folder and repository (a related task usually launches beside its asker).
 */
export async function sessionOwnerScope(
  context: RpcContext,
  rows: readonly SessionManageSidebarRow[],
  actor: SessionManageActor,
  params: { folder?: string; repo?: string; worktree?: string }
): Promise<SessionOwnerScope> {
  return withSessionOwnerProject(context, await sessionOwnerPlace(context, rows, actor, params))
}

async function sessionOwnerPlace(
  context: RpcContext,
  rows: readonly SessionManageSidebarRow[],
  actor: SessionManageActor,
  params: { folder?: string; repo?: string; worktree?: string }
): Promise<SessionOwnerScope> {
  const target = params.worktree ? { targetWorktreeId: params.worktree } : {}
  if (params.folder !== undefined || params.repo !== undefined) {
    const repo = params.repo?.toLowerCase()
    const repoRow = repo
      ? rows.find(
          (row) => row.repoId?.toLowerCase() === repo || row.repoLabel?.toLowerCase() === repo
        )
      : undefined
    return {
      ...target,
      ...(params.folder !== undefined
        ? { folderId: await folderFilterId(context, params.folder) }
        : {}),
      ...(params.repo !== undefined ? { repoId: repoRow?.repoId ?? params.repo } : {})
    }
  }
  const own = actor.kind === 'pane' ? rows.find((row) => row.paneKey === actor.paneKey) : undefined
  return own
    ? { worktreeId: own.worktreeId, folderId: own.folderId, repoId: own.repoId, ...target }
    : target
}

export const SESSION_MANAGE_OWNER_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_MANAGE_RPC.findOwner,
    params: SessionManageFindOwnerParams,
    handler: async (params, context): Promise<SessionFindOwnerResult> => {
      assertSessionManageCaller(context)
      const timing = createSessionOwnerTimingRecorder()
      const rows = await timing.time('sidebar', () => readSidebarRows(context.runtime))
      const actor = actorFor(context, rows)
      const scope = await timing.time('scope', () =>
        sessionOwnerScope(context, rows, actor, params)
      )
      return findSessionOwnerOnRuntime(
        context.runtime,
        rows,
        {
          task: params.task,
          ...(params.files ? { files: params.files } : {}),
          scope,
          exclude: new Set(actor.kind === 'pane' ? [actor.paneKey] : []),
          pastWork: true
        },
        timing
      )
    }
  }),
  defineMethod({
    name: SESSION_MANAGE_RPC.assign,
    params: SessionManageAssignParams,
    handler: async (params, context) => {
      if (params.ref !== undefined) {
        return assignByRefOnRuntime(context, { ...params, ref: params.ref })
      }
      return (await assignOnPane(context, params.target!, params)).result
    }
  })
]
