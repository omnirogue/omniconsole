/**
 * `omni workflow status <run-id>` — one workflow run by id: its state, where it was placed, who
 * asked an agent to start it, every launched attempt with the host and session it ran in, and the
 * findings verified so far, so an agent can report the run and a person can find its seats.
 */

import { z } from 'zod'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import {
  LOCAL_WORKFLOW_METHODS,
  type LocalWorkflowRunStatus
} from '../../shared/local-workflow-rpc'
import { workflowPlacementSummary } from '../../shared/local-workflow-placement'
import { EVOLVE_RUN_ID_PREFIX } from '../../shared/evolve-workflow'
import { workflowStatusEvolve } from './workflow-evolve'

/** The report for a person: one line per fact, one per seat attempt, then each verified finding. */
export function workflowStatusLines(status: LocalWorkflowRunStatus): string[] {
  return [
    `Run ${status.executionId}: ${status.state}${status.error ? ` (${status.error})` : ''}`,
    status.placement
      ? `Placed on ${workflowPlacementSummary(status.placement)}`
      : 'Placed on this computer (before placement was a choice)',
    ...(status.placement?.dispatch
      ? [`Folder on ${status.placement.host?.name}: ${status.placement.dispatch.root}`]
      : []),
    ...(status.requestedBy
      ? [`Requested by ${status.requestedBy}: "${status.request ?? ''}"`]
      : []),
    ...status.seats.map(
      (seat) =>
        `  ${seat.callId} #${seat.attempt} ${seat.state} on ${seat.host}${seat.route ? ` · ${seat.route}${seat.model ? ` ${seat.model}` : ''}` : ''}${seat.sessionId ? ` · session ${seat.sessionId}` : ''}${seat.remoteDirectory ? ` · ${seat.remoteDirectory}` : ''}`
    ),
    ...(status.verified ? [`Verified so far: ${status.verified.count}`] : []),
    ...(status.verified?.items ?? []).map(
      (item) => `  [${item.severity}] ${item.title}${item.location ? ` · ${item.location}` : ''}`
    )
  ]
}

export const workflowStatus: CommandHandler = async (ctx) => {
  const executionId = ctx.flags.get('run-id')
  if (typeof executionId !== 'string' || !executionId.trim()) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Say which run: omni workflow status <run-id>.'
    )
  }
  if (executionId.trim().startsWith(EVOLVE_RUN_ID_PREFIX)) {
    return await workflowStatusEvolve(ctx)
  }
  const status = (
    await ctx.client.call<LocalWorkflowRunStatus>(LOCAL_WORKFLOW_METHODS.runStatus, {
      executionId: executionId.trim()
    })
  ).result
  console.log(ctx.json ? JSON.stringify(status, null, 2) : workflowStatusLines(status).join('\n'))
}

export const discoverDeliver: CommandHandler = async (ctx) => {
  const executionId = ctx.flags.get('run-id')
  if (typeof executionId !== 'string' || !z.string().uuid().safeParse(executionId).success) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Say which run: omni discover deliver <run-id UUID>.'
    )
  }
  const result = (
    await ctx.client.call<{ outcome: string; url?: string; reason?: string }>(
      LOCAL_WORKFLOW_METHODS.discoverDeliver,
      { executionId }
    )
  ).result
  console.log(
    ctx.json
      ? JSON.stringify(result, null, 2)
      : `Discover ${executionId}: ${result.outcome}${result.url ? ` · ${result.url}` : ''}${result.reason ? ` · ${result.reason}` : ''}`
  )
  if (result.outcome === 'failed' || result.outcome === 'unknown') {
    process.exitCode = 1
  }
}

export const WORKFLOW_STATUS_HANDLERS: Record<string, CommandHandler> = {
  'discover deliver': discoverDeliver,
  'workflow status': workflowStatus
}
