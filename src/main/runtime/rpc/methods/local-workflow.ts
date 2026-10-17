import { hostname } from 'node:os'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { readDiscoverStats } from '../../workflow-script/workflow-discover-stats'
import { workflowEvidenceDigest } from '../../workflow-script/workflow-evidence-digest'
import { LocalWorkflowStartDraftSchema } from './local-workflow-start-schema'
import { workflowCatalogModels } from '../../workflow-script/local-workflow-models'
import { WorkflowModelPresetInputSchema } from '../../../../shared/workflow-model-presets'
import { WorkflowModelTiersSchema } from '../../../../shared/workflow-model-tiers'
import { workflowOpenRouterModelsSnapshot } from '../../workflow-script/workflow-openrouter-catalog'
import { assertSessionOutcomeUser } from '../../session-outcome-authority'
import { z } from 'zod'
import {
  LOCAL_WORKFLOW_METHODS,
  type LocalWorkflowWatchEvent
} from '../../../../shared/local-workflow-rpc'
import { localWorkflowFindRequestSchema } from '../../../../shared/local-workflow-find-request'
import { localWorkflowRunRequestSchema } from '../../../../shared/local-workflow-run-request'
import { workflowJudgingStatsRequestSchema } from '../../../../shared/workflow-judging-stats'
import { workflowJudgingStats } from '../../workflow-script/workflow-judging-stats'
import { discoverDecisionStats } from '../../workflow-script/discover-omnios-decision-stats'
import { getLocalWorkflowHost } from '../../workflow-script/local-workflow-runtime-host'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import {
  agentWorkflowLaunchRefusal,
  assertAgentWorkflowLaunch,
  assertLocalWorkflowCaller as localCaller
} from './rpc-agent-caller'
import { LOCAL_WORKFLOW_FLEET_RPC_METHODS } from './local-workflow-fleet'
import { setSessionWorkflowRunReaderFactory } from '../../../session-manage/session-manage-workflow-runtime'
import { readRuntimeWorkflowRun } from '../../../session-manage/session-manage-workflow-reader'

// Why here: this module already holds the workflow controller, so session management reads runs
// through it without importing that graph itself (see session-manage-workflow-runtime.ts).
setSessionWorkflowRunReaderFactory(readRuntimeWorkflowRun)

const Address = z
  .object({
    worktree: z.string().min(1).max(32_768),
    conversationId: z.string().min(1).max(512)
  })
  .strict()
const Setup = Address.extend({ preset: z.enum(['council', 'discover']) })
const Start = Setup.extend({ requestId: z.string().uuid(), draft: LocalWorkflowStartDraftSchema })
const Show = Address.extend({ executionId: z.string().uuid() })
const Control = Show.extend({
  fence: z.number().int().positive(),
  action: z.enum(['pause', 'resume', 'stop', 'retry', 'finish'])
})
const ReadCall = Show.extend({ callId: z.string().min(1).max(512) })
const Find = z
  .object({
    worktree: z.string().min(1).max(32_768),
    request: localWorkflowFindRequestSchema
  })
  .strict()
const Run = z
  .object({
    worktree: z.string().min(1).max(32_768),
    request: localWorkflowRunRequestSchema
  })
  .strict()

export const LOCAL_WORKFLOW_RPC_METHODS: RpcAnyMethod[] = [
  ...LOCAL_WORKFLOW_FLEET_RPC_METHODS,
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.models,
    params: z.object({}).strict(),
    handler: async (_params, context) => {
      localCaller(context)
      return await workflowOpenRouterModelsSnapshot()
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.listModelPresets,
    params: z.object({}).strict(),
    handler: (_params, context) => {
      localCaller(context)
      assertSessionOutcomeUser(context)
      return { presets: context.runtime.listWorkflowModelPresets() }
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.saveModelPreset,
    params: WorkflowModelPresetInputSchema,
    handler: (params, context) => {
      localCaller(context)
      assertSessionOutcomeUser(context)
      const models = params.models.map((entry) => ({
        ...entry,
        model:
          entry.model ??
          workflowCatalogModels(entry.route).find((model) => model.catalog.isDefault)?.catalog.id
      }))
      return {
        presets: context.runtime.saveWorkflowModelPreset({ ...params, models })
      }
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.deleteModelPreset,
    params: z.object({ id: z.string().uuid() }).strict(),
    handler: (params, context) => {
      localCaller(context)
      assertSessionOutcomeUser(context)
      return { presets: context.runtime.deleteWorkflowModelPreset(params.id) }
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.modelTiers,
    params: z.object({}).strict(),
    handler: (_params, context) => {
      localCaller(context)
      return context.runtime.readWorkflowModelTiers()
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.saveModelTiers,
    // `tiers: null` goes back to the built-in lineups.
    params: z.object({ tiers: WorkflowModelTiersSchema.nullable() }).strict(),
    handler: (params, context) => {
      localCaller(context)
      assertSessionOutcomeUser(context)
      return context.runtime.saveWorkflowModelTiers(params.tiers)
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.setup,
    params: Setup,
    handler: async (params, context) => {
      localCaller(context)
      return (await getLocalWorkflowHost(context.runtime)).setup(params)
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.start,
    params: Start,
    handler: async (params, context) => {
      localCaller(context)
      // The kind a person knows: a graph's template, else the preset.
      const kind = params.draft.audit
        ? 'audit'
        : (params.draft.graph?.spec.template ?? params.preset)
      const reason = agentWorkflowLaunchRefusal(context, kind, params.draft)
      if (reason) {
        return { rejected: true as const, reason }
      }
      return (await getLocalWorkflowHost(context.runtime)).start(params)
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.show,
    params: Show,
    handler: async (params, context) => {
      localCaller(context)
      return (await getLocalWorkflowHost(context.runtime)).show(params)
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.control,
    params: Control,
    handler: async (params, context) => {
      localCaller(context)
      return (await getLocalWorkflowHost(context.runtime)).control(params)
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.status,
    params: Show,
    handler: async (params, context) => {
      localCaller(context)
      return (await getLocalWorkflowHost(context.runtime)).status(params)
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.readCall,
    params: ReadCall,
    handler: async (params, context) => {
      localCaller(context)
      return (await getLocalWorkflowHost(context.runtime)).readCall(params)
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.find,
    params: Find,
    handler: async (params, context) => {
      localCaller(context)
      return context.runtime.startLocalWorkflowFind(params.worktree, params.request)
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.run,
    params: Run,
    handler: async (params, context) => {
      localCaller(context)
      assertAgentWorkflowLaunch(context, params.request.template, params.request)
      return context.runtime.startLocalWorkflowFind(params.worktree, params.request)
    }
  }),
  defineMethod({
    name: LOCAL_WORKFLOW_METHODS.stats,
    params: workflowJudgingStatsRequestSchema,
    // Read-only: the execution host sums up its own judging record and changes nothing.
    handler: async (params, context) => {
      localCaller(context)
      const stats = await workflowJudgingStats(params)
      const userData = getAppEnvironment().getPath('userData')
      return {
        ...stats,
        discover: readDiscoverStats(
          context.runtime.getOrchestrationDb().db,
          join(userData, 'discover-omnios'),
          params,
          `${hostname()}:${workflowEvidenceDigest(userData)}`
        ),
        decisions: discoverDecisionStats(join(userData, 'discover-omnios'), params)
      }
    }
  }),
  defineStreamingMethod({
    name: LOCAL_WORKFLOW_METHODS.watch,
    params: Show,
    // Authorization and recovery finish before the runtime owns cleanup, so a refused watch
    // leaves nothing registered. The handler then stays pending until the caller aborts or its
    // connection goes away, which keeps the desktop IPC unsubscribe able to reach it.
    handler: async (params, ctx, emit) => {
      localCaller(ctx)
      const host = await getLocalWorkflowHost(ctx.runtime)
      let closed = false
      const stop = await host.watch(params, (view) => {
        if (!closed) {
          emit({ type: 'view', view } satisfies LocalWorkflowWatchEvent)
        }
      })
      const id = `localWorkflowWatch:${ctx.connectionId ?? 'local'}:${ctx.requestId ?? params.executionId}`
      await new Promise<void>((resolve) => {
        const cleanup = () => {
          closed = true
          ctx.signal?.removeEventListener('abort', onAbort)
          stop()
          resolve()
        }
        let registration: { releaseIfCurrent: () => void }
        if (typeof ctx.runtime.registerOwnedSubscriptionCleanup === 'function') {
          registration = ctx.runtime.registerOwnedSubscriptionCleanup(id, cleanup, ctx.connectionId)
        } else {
          ctx.runtime.registerSubscriptionCleanup(id, cleanup, ctx.connectionId)
          registration = {
            releaseIfCurrent: () => ctx.runtime.cleanupSubscription(id)
          }
        }
        const onAbort = () => registration.releaseIfCurrent()
        ctx.signal?.addEventListener('abort', onAbort, { once: true })
        if (ctx.signal?.aborted) {
          onAbort()
        }
      })
    }
  })
]
