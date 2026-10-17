import { HUB_TASK_ID_PATTERN } from '../../../../shared/omnios-task-binding'
import { z } from 'zod'
import {
  BUILD_REVIEW_RPC,
  BUILD_REVIEW_MAX_REVIEWERS,
  BUILD_REVIEW_MAX_ROUNDS
} from '../../../../shared/build-review-pipeline'
import { getBuildReviewService } from '../../build-review/build-review-service-registry'
import {
  REVIEW_RUBRIC_IDS,
  REVIEW_RUBRIC_MAX_CHARS,
  REVIEW_RUBRIC_NAME_MAX_CHARS
} from '../../../../shared/review-rubrics'
import { defineMethod, type RpcMethod } from '../core'
import { assertAgentWorkflowLaunch } from './rpc-agent-caller'
import { workflowLaunchChoiceFields } from '../../../../shared/workflow-agent-launch'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

const Rubric = z.object({
  id: z.enum(REVIEW_RUBRIC_IDS),
  name: z.string().trim().min(1).max(REVIEW_RUBRIC_NAME_MAX_CHARS),
  instructions: z.string().trim().min(1).max(REVIEW_RUBRIC_MAX_CHARS)
})

const AgentChoice = z.object({
  agent: requiredString('Missing agent'),
  model: OptionalString,
  effort: OptionalString,
  rubric: Rubric.optional()
})

const StartParams = z.object({
  worktree: requiredString('Missing worktree'),
  objective: requiredString('Missing objective'),
  builder: AgentChoice.optional(),
  reviewer: AgentChoice.optional(),
  reviewers: z.array(AgentChoice).min(1).max(BUILD_REVIEW_MAX_REVIEWERS).optional(),
  maxReviewRounds: z.number().int().min(1).max(BUILD_REVIEW_MAX_ROUNDS).optional(),
  reviewFocus: OptionalString,
  evidence: z.enum(['required', 'off']).optional(),
  hubTaskId: z
    .string()
    .regex(HUB_TASK_ID_PATTERN, 'The omnios card id must look like btk_…')
    .optional(),
  runsOn: z.enum(['fleet', 'local']).optional(),
  ...workflowLaunchChoiceFields
})

const IdParams = z.object({ id: requiredString('Missing pipeline id') })

const ReplyParams = IdParams.extend({
  messageId: requiredString('Missing messageId'),
  body: requiredString('Missing body')
})

const ReadWorkerParams = IdParams.extend({
  role: z.enum(['builder', 'reviewer']),
  reviewer: z.number().int().positive().optional(),
  cursor: z.union([z.number().int().nonnegative(), z.string().min(1).max(2_048)]).optional(),
  limit: OptionalFiniteNumber
})

/**
 * Desktop-owned Build + Review coordinator. These methods are not orchestration
 * mutations themselves; the service performs the orchestration calls in-process
 * with the current contract version, so any client (renderer, CLI, paired
 * device) can drive a pipeline without holding a coordinator terminal.
 */
export const BUILD_REVIEW_METHODS: RpcMethod[] = [
  defineMethod({
    name: BUILD_REVIEW_RPC.start,
    params: StartParams,
    handler: (params, context) => {
      assertAgentWorkflowLaunch(context, 'build-review', params)
      return { pipeline: getBuildReviewService(context.runtime).start(params) }
    }
  }),
  // Why a method of its own: a host from before placement strips `runsOn` from `start` and runs
  // the pipeline here, so a client asks this first and refuses a fleet Start where it is unknown.
  defineMethod({
    name: BUILD_REVIEW_RPC.placementSupport,
    params: null,
    // `hosts`: `start` takes runsOnHost; a client refuses a named host where this is absent.
    handler: () => ({ runsOn: ['fleet', 'local'] as const, hosts: true as const })
  }),
  defineMethod({
    name: BUILD_REVIEW_RPC.list,
    params: null,
    handler: (_params, { runtime }) => ({ pipelines: getBuildReviewService(runtime).list() })
  }),
  defineMethod({
    name: BUILD_REVIEW_RPC.show,
    params: IdParams,
    handler: (params, { runtime }) => ({
      pipeline: getBuildReviewService(runtime).show(params.id)
    })
  }),
  defineMethod({
    name: BUILD_REVIEW_RPC.cancel,
    params: IdParams,
    handler: async (params, { runtime }) => ({
      pipeline: await getBuildReviewService(runtime).cancel(params.id)
    })
  }),
  defineMethod({
    name: BUILD_REVIEW_RPC.reply,
    params: ReplyParams,
    handler: async (params, { runtime }) => ({
      pipeline: await getBuildReviewService(runtime).reply(params.id, params.messageId, params.body)
    })
  }),
  defineMethod({
    name: BUILD_REVIEW_RPC.retry,
    params: IdParams,
    handler: async (params, { runtime }) => ({
      pipeline: await getBuildReviewService(runtime).retry(params.id)
    })
  }),
  defineMethod({
    name: BUILD_REVIEW_RPC.releaseWorkspace,
    params: IdParams,
    handler: async (params, { runtime }) => ({
      pipeline: await getBuildReviewService(runtime).releaseWorkspace(params.id)
    })
  }),
  defineMethod({
    name: BUILD_REVIEW_RPC.readWorker,
    params: ReadWorkerParams,
    handler: (params, { runtime }) =>
      getBuildReviewService(runtime).readWorker(params.id, params.role, {
        cursor: params.cursor,
        limit: params.limit,
        reviewer: params.reviewer
      })
  })
]
