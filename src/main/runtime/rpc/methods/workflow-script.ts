import { z } from 'zod'
import { WORKFLOW_SCRIPT_RPC } from '../../../../shared/workflow-script-types'
import { dryRunWorkflowScript } from '../../workflow-script/workflow-script-dry-run'
import { readWorkflowScriptMeta } from '../../workflow-script/workflow-script-sandbox'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

/** A script is read whole; anything past this is not a workflow, it is a paste gone wrong. */
export const WORKFLOW_SCRIPT_MAX_SOURCE_CHARS = 256_000

const SourceParams = z.object({
  source: requiredString('Missing script source').pipe(
    z.string().max(WORKFLOW_SCRIPT_MAX_SOURCE_CHARS)
  )
})

const DryRunParams = SourceParams.extend({
  args: z.unknown().optional(),
  richness: z.number().int().min(0).max(64).optional(),
  budgetTotal: z.number().int().positive().nullable().optional()
})

export const WORKFLOW_SCRIPT_DRY_RUN_METHOD = defineMethod({
  name: WORKFLOW_SCRIPT_RPC.dryRun,
  params: DryRunParams,
  handler: async (params) => ({
    run: await dryRunWorkflowScript({
      source: params.source,
      args: params.args,
      richness: params.richness,
      budgetTotal: params.budgetTotal ?? null
    })
  })
})

/**
 * Only readMeta is registered, reachable from the CLI and any session on this host:
 * read a script's `meta` without running it, starting an agent or touching the orchestration store.
 */
// Why: log.constructor('return process')() escapes the realm and exposes the host process.
// Re-register dryRun only in a child-process or worker realm that receives no host functions.
export const WORKFLOW_SCRIPT_METHODS: RpcMethod[] = [
  defineMethod({
    name: WORKFLOW_SCRIPT_RPC.readMeta,
    params: SourceParams,
    handler: (params) => ({ meta: readWorkflowScriptMeta(params.source) })
  })
]
