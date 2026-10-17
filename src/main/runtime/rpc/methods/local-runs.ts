import { z } from 'zod'
import { LOCAL_RUN_MAX_CONCURRENT, LOCAL_RUN_MAX_NODES } from '../../../../shared/local-run-graph'
import { LOCAL_RUN_RPC } from '../../../../shared/local-run-types'
import { getLocalRunService } from '../../build-review/local-run-service'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

const Actor = z.object({
  agent: requiredString('Missing agent'),
  model: OptionalString,
  effort: OptionalString,
  accountChoiceId: OptionalString
})

const Node = z.object({
  id: requiredString('Missing node id'),
  actor: Actor,
  presetId: requiredString('Missing presetId'),
  objective: requiredString('Missing objective'),
  gate: z
    .object({
      question: requiredString('Missing question'),
      options: z.array(z.string()).optional()
    })
    .optional(),
  deliver: z
    .object({
      taskId: requiredString('Missing card id'),
      to: z.array(z.string().min(1)).min(1),
      message: OptionalString
    })
    .optional(),
  placement: z.enum(['local', 'fleet']).optional(),
  deps: z.array(z.string().min(1)).optional()
})

const CreateParams = z.object({
  graph: z.object({
    nodes: z.array(Node).min(1).max(LOCAL_RUN_MAX_NODES),
    workspacePath: requiredString('Missing workspacePath'),
    maxConcurrent: z.number().int().min(1).max(LOCAL_RUN_MAX_CONCURRENT).optional()
  })
})

const IdParams = z.object({ id: requiredString('Missing run id') })

const ResolveGateParams = IdParams.extend({
  gateId: requiredString('Missing gate id'),
  resolution: requiredString('Missing resolution')
})

const ReplyParams = IdParams.extend({
  messageId: requiredString('Missing messageId'),
  body: requiredString('Missing body')
})

const DraftParams = z.object({
  id: requiredString('Missing draft id'),
  title: OptionalString,
  graph: CreateParams.shape.graph
})

/**
 * The local DAG runner, driven without any UI. These methods are not orchestration
 * mutations themselves: the runner performs its orchestration calls in-process with
 * the current contract version, exactly as Build + Review does.
 */
export const LOCAL_RUN_METHODS: RpcMethod[] = [
  defineMethod({
    name: LOCAL_RUN_RPC.create,
    params: CreateParams,
    handler: (params, { runtime }) => ({ run: getLocalRunService(runtime).create(params.graph) })
  }),
  defineMethod({
    name: LOCAL_RUN_RPC.start,
    params: IdParams,
    handler: (params, { runtime }) => ({ run: getLocalRunService(runtime).start(params.id) })
  }),
  defineMethod({
    name: LOCAL_RUN_RPC.status,
    params: IdParams,
    handler: (params, { runtime }) => ({ run: getLocalRunService(runtime).show(params.id) })
  }),
  defineMethod({
    name: LOCAL_RUN_RPC.list,
    params: null,
    handler: (_params, { runtime }) => ({ runs: getLocalRunService(runtime).list() })
  }),
  defineMethod({
    name: LOCAL_RUN_RPC.resolveGate,
    params: ResolveGateParams,
    handler: async (params, { runtime }) => ({
      run: await getLocalRunService(runtime).resolveGate(
        params.id,
        params.gateId,
        params.resolution
      )
    })
  }),
  defineMethod({
    name: LOCAL_RUN_RPC.reply,
    params: ReplyParams,
    handler: async (params, { runtime }) => ({
      run: await getLocalRunService(runtime).reply(params.id, params.messageId, params.body)
    })
  }),
  defineMethod({
    name: LOCAL_RUN_RPC.cancel,
    params: IdParams,
    handler: async (params, { runtime }) => ({
      run: await getLocalRunService(runtime).cancel(params.id)
    })
  }),
  defineMethod({
    name: LOCAL_RUN_RPC.saveDraft,
    params: DraftParams,
    handler: (params, { runtime }) => ({
      draft: runtime.upsertLocalRunDraft({
        id: params.id,
        title: params.title ?? params.id,
        graph: params.graph
      })
    })
  }),
  defineMethod({
    name: LOCAL_RUN_RPC.listDrafts,
    params: null,
    handler: (_params, { runtime }) => ({ drafts: runtime.listLocalRunDrafts() })
  }),
  defineMethod({
    name: LOCAL_RUN_RPC.removeDraft,
    params: z.object({ id: requiredString('Missing draft id') }),
    handler: (params, { runtime }) => ({ removed: runtime.removeLocalRunDraft(params.id) })
  })
]
