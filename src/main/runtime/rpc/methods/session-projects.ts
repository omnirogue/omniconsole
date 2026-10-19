// `sessionProjects.*` — project settings for `omni folder project…` and for CLI and dispatch
// launches that inherit them (plan §8). The settings live with the sidebar folders in the desktop
// window, so reads are relayed there; only the local socket may ask, like `sessionFolders.*`.
// Nothing here creates a project: people make projects in the window, and a caller on this
// socket can only suggest one (Sal, 2026-09-01), which the window shows as a notice.

import { validateSessionContext } from '../../../../shared/session-context-attachments'
import {
  PROJECT_CREATE_REFUSED_AGENT,
  PROJECT_CREATE_REFUSED_CLI,
  SESSION_PROJECTS_RPC,
  SessionProjectBindLaunchParamsSchema,
  SessionProjectCreateParamsSchema,
  SessionProjectListParamsSchema,
  SessionProjectResolveLaunchParamsSchema,
  SessionProjectShowParamsSchema,
  SessionProjectSuggestParamsSchema
} from '../../../../shared/session-project-cli'
import { readSidebarRows } from '../../../session-manage/session-manage-runtime-actions'
import { unattendedContextFor } from '../../../session-manage/session-manage-unattended'
import { bindProjectLaunchContext } from '../../../session-projects/project-for-pane'
import { listSessionProjects } from '../../../session-projects/project-list'
import {
  projectLaunchRuntime,
  resolveProjectLaunchInMain
} from '../../../session-projects/project-launch-resolve'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { assertLocalSessionFolderCaller } from './session-folders'
import { actorFor } from './session-manage-support'

/** This computer's CLI, or a person on a paired desktop; never an agent on another computer. */
function assertProjectListCaller(context: RpcContext): void {
  if (!context.pairedDeviceId && !context.clientId && !context.clientKind) {
    return
  }
  const pairedPerson =
    context.clientKind === 'runtime' &&
    !!context.pairedDeviceId &&
    !context.orchestrationCapability &&
    !context.orchestrationCompatibilityEvidence
  if (!pairedPerson) {
    assertLocalSessionFolderCaller(context)
  }
}

async function callerActor(context: RpcContext) {
  return actorFor(
    context,
    context.orchestrationCompatibilityEvidence ? await readSidebarRows(context.runtime) : []
  )
}

export const SESSION_PROJECT_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_PROJECTS_RPC.show,
    params: SessionProjectShowParamsSchema,
    handler: async (params, context) => {
      assertLocalSessionFolderCaller(context)
      return context.runtime.requestSessionFolders({ kind: 'readProject', folder: params.folder })
    }
  }),
  defineMethod({
    name: SESSION_PROJECTS_RPC.suggest,
    params: SessionProjectSuggestParamsSchema,
    handler: async (params, context) => {
      assertLocalSessionFolderCaller(context)
      const actor = await callerActor(context)
      const by = actor.kind === 'pane' ? `The session “${actor.title}”` : 'A command-line caller'
      return context.runtime.requestSessionFolders({
        kind: 'suggestProject',
        folder: params.folder,
        by,
        reason: params.reason
      })
    }
  }),
  defineMethod({
    name: SESSION_PROJECTS_RPC.create,
    params: SessionProjectCreateParamsSchema,
    handler: async (_params, context) => {
      assertLocalSessionFolderCaller(context)
      const actor = await callerActor(context)
      // Why every caller: a pane or steward is an agent, and the plain CLI cannot prove a person.
      throw new Error(
        actor.kind === 'pane' || actor.kind === 'steward' || unattendedContextFor(actor)
          ? PROJECT_CREATE_REFUSED_AGENT
          : PROJECT_CREATE_REFUSED_CLI
      )
    }
  }),
  defineMethod({
    name: SESSION_PROJECTS_RPC.resolveLaunch,
    params: SessionProjectResolveLaunchParamsSchema,
    handler: async (params, context) => {
      assertLocalSessionFolderCaller(context)
      return resolveProjectLaunchInMain(projectLaunchRuntime(context.runtime), params)
    }
  }),
  defineMethod({
    name: SESSION_PROJECTS_RPC.bindLaunch,
    params: SessionProjectBindLaunchParamsSchema,
    handler: async (params, context) => {
      assertLocalSessionFolderCaller(context)
      validateSessionContext(params.items)
      const terminal = await context.runtime.showTerminal(params.terminal)
      const bound = await bindProjectLaunchContext(context.runtime, {
        tabId: terminal.tabId,
        worktreeId: terminal.worktreeId,
        items: params.items
      })
      return { bound }
    }
  }),
  defineMethod({
    name: SESSION_PROJECTS_RPC.list,
    params: SessionProjectListParamsSchema,
    handler: async (_params, context) => {
      assertProjectListCaller(context)
      return listSessionProjects({
        requestSessionFolders: (request) => context.runtime.requestSessionFolders(request),
        readProjectRows: (projectFolderId) => readSidebarRows(context.runtime, { projectFolderId })
      })
    }
  })
]
