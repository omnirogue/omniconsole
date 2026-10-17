import { SESSION_PREP_PARAMS, SESSION_PREP_RPC } from '../../../../shared/session-prep-types'
import { assertSessionOutcomeUser } from '../../session-outcome-authority'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import {
  folderWorkspace,
  repoWorkspace
} from '../../../session-prep/session-prep-runtime-workspaces'
import { authenticateSessionPrepConnector } from '../../../session-prep/session-prep-connector-authority'

async function connectorRequest(
  params: typeof SESSION_PREP_PARAMS.request._output,
  context: RpcContext
) {
  const authority = authenticateSessionPrepConnector(params.connector!, params.text, context)
  const folder = context.runtime
    .listFolderWorkspaces()
    .find((entry) => entry.folderPath === authority.workspace)
  const workspace = folder
    ? { id: `folder:${folder.id}`, connectionId: folder.connectionId }
    : await context.runtime.showManagedWorktree(`path:${authority.workspace}`)
  const parsed = splitWorktreeId(workspace.id)
  const repo = parsed && context.runtime.listRepos().find((entry) => entry.id === parsed.repoId)
  const target = folder ? folderWorkspace(folder) : repo && repoWorkspace(repo, authority.workspace)
  if (!target || target.isRemote || target.connectionId || target.hostId !== 'local') {
    throw new Error('Connector preparation must execute on the workspace owner.')
  }
  const prep = context.runtime.getSessionPrepService()
  return prep.requestConnector(
    {
      text: authority.claims.text,
      requestId: `connector:${authority.claims.operator}:${authority.claims.requestId}`,
      source: {
        worktreeId: workspace.id,
        paneKey: `connector:${authority.claims.operator}:${authority.claims.requestId}`,
        agent: authority.claims.provider ?? 'claude'
      },
      context: ''
    },
    {
      operator: authority.claims.operator,
      digest: authority.digest,
      launch: params.connector!.launch,
      nonce: authority.claims.nonce,
      expiresAt: authority.claims.expiresAt,
      statusOnly: params.connector!.statusOnly === true
    }
  )
}

function service(context: RpcContext) {
  assertSessionOutcomeUser(context)
  return context.runtime.getSessionPrepService()
}

export const SESSION_PREP_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_PREP_RPC.request,
    params: SESSION_PREP_PARAMS.request,
    handler: (params, context) => {
      if (params.connector) {
        return connectorRequest(params, context)
      }
      const prep = service(context)
      return params.requestId ? prep.requestDurable(params) : prep.request(params)
    }
  }),
  defineMethod({
    name: SESSION_PREP_RPC.get,
    params: SESSION_PREP_PARAMS.get,
    handler: (params, context) => ({ batch: service(context).get(params.batchId) })
  }),
  defineMethod({
    name: SESSION_PREP_RPC.listForSource,
    params: SESSION_PREP_PARAMS.listForSource,
    handler: (params, context) => ({
      batches: service(context).listForSource(params.paneKey)
    })
  }),
  defineMethod({
    name: SESSION_PREP_RPC.cancel,
    params: SESSION_PREP_PARAMS.cancel,
    handler: (params, context) =>
      service(context)
        .cancel(params.batchId)
        .then((batch) => ({ batch }))
  }),
  defineMethod({
    name: SESSION_PREP_RPC.confirm,
    params: SESSION_PREP_PARAMS.confirm,
    handler: (params, context) =>
      service(context)
        .confirm(params.batchId)
        .then((batch) => ({ batch }))
  }),
  defineMethod({
    name: SESSION_PREP_RPC.decideReuse,
    params: SESSION_PREP_PARAMS.decideReuse,
    handler: (params, context) =>
      service(context)
        .decideReuse(params.batchId, params.index, params.choice)
        .then((batch) => ({ batch }))
  })
]
