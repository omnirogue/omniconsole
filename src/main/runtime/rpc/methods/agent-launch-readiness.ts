import { z } from 'zod'
import {
  AGENT_LAUNCH_READINESS_METHOD,
  type AgentLaunchReadinessParams,
  type AgentLaunchReadinessResult
} from '../../../../shared/agent-launch-account'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { defineMethod, type RpcAnyMethod } from '../core'
import { StrictNonEmptyString, WorktreeSelector } from './agent-session'

const MAX_MODEL_LENGTH = 512

export const AgentLaunchReadinessParamsSchema: z.ZodType<AgentLaunchReadinessParams> = z
  .object({
    worktree: WorktreeSelector,
    agent: z.enum(['claude', 'codex']),
    model: StrictNonEmptyString(MAX_MODEL_LENGTH, 'Invalid model').optional(),
    preview: z.boolean(),
    load: z.boolean().optional()
  })
  .strict()

type AgentLaunchReadinessRuntime = OrcaRuntimeService & {
  agentLaunchReadiness(params: AgentLaunchReadinessParams): Promise<AgentLaunchReadinessResult>
}

// Why its own module: read-only, and kept off the unattended and mobile allowlists like launches.
export const AGENT_LAUNCH_READINESS_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: AGENT_LAUNCH_READINESS_METHOD,
    params: AgentLaunchReadinessParamsSchema,
    handler: (params, { runtime }) =>
      (runtime as AgentLaunchReadinessRuntime).agentLaunchReadiness(params)
  })
]
