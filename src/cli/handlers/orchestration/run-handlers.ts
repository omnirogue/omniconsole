import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalNonNegativeIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../../flags'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../shared/orchestration-run-pagination'
import type { RunQueueSummary } from '../../../shared/orchestration-run-queue'
import { ORCHESTRATION_RUN_QUEUE_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { RuntimeClientError } from '../../runtime-client'
import { formatRunQueue } from './run-queue-format'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'

export const ORCHESTRATION_RUN_HANDLERS: Record<string, CommandHandler> = {
  'orchestration run-create': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client, {
      allowActiveFallback: false
    })
    const hubTaskId = getOptionalStringFlag(flags, 'hub-task-id')
    const hubStateRevision = getOptionalNonNegativeIntegerFlag(flags, 'hub-state-revision')
    const result = await callOrchestrationMutation<{
      run: { id: string; objective: string; consumer_generation: number }
    }>(client, flags, 'orchestration.runCreate', {
      objective: getRequiredStringFlag(flags, 'objective'),
      from,
      ...(hubTaskId ? { hubTaskId } : {}),
      ...(hubStateRevision !== undefined ? { hubStateRevision } : {})
    })
    printResult(result, json, (r) => `Run ${r.run.id} created and bound: ${r.run.objective}`)
  },

  'orchestration run-use': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client, {
      allowActiveFallback: false
    })
    const result = await callOrchestrationMutation<{
      run: { id: string; objective: string; consumer_generation: number }
    }>(client, flags, 'orchestration.runUse', {
      id: getRequiredStringFlag(flags, 'id'),
      from,
      ...(flags.has('takeover-legacy') ? { takeoverLegacy: true } : {})
    })
    printResult(result, json, (r) => `Using Run ${r.run.id}: ${r.run.objective}`)
  },

  'orchestration run-current': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      run: { id: string; objective: string } | null
    }>('orchestration.runCurrent', { from })
    printResult(result, json, (r) =>
      r.run ? `${r.run.id} ${r.run.objective}` : 'No Run is bound to this terminal.'
    )
  },

  'orchestration run-list': async ({ flags, client, json }) => {
    const result = await client.call<{
      runs: { id: string; objective: string; legacy: number }[]
      nextCursor: string | null
    }>('orchestration.runList', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit') ?? ORCHESTRATION_RUN_PAGE_LIMIT,
      cursor: getOptionalStringFlag(flags, 'cursor')
    })
    printResult(result, json, (r) => {
      const rows =
        r.runs.length === 0
          ? 'No Runs found.'
          : r.runs
              .map(
                (run) => `${run.id}${run.legacy ? ' [legacy, inspect only]' : ''} ${run.objective}`
              )
              .join('\n')
      return r.nextCursor ? `${rows}\nMore Runs: --cursor ${r.nextCursor}` : rows
    })
  },

  'orchestration run-show': async ({ flags, client, json }) => {
    const queue = flags.has('queue')
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    if (limit !== undefined && !queue) {
      throw new RuntimeClientError('invalid_argument', '--limit requires --queue')
    }
    if (queue) {
      // Why: an older runtime strips the unknown field and answers a plain show, which would
      // read as "nothing is queued". Refuse instead of printing that.
      const status = await client.call<RuntimeStatus>('status.get')
      if (!status.result.capabilities?.includes(ORCHESTRATION_RUN_QUEUE_RUNTIME_CAPABILITY)) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'The connected runtime does not support the Run queue summary. Update it, or use task-list --run and worker-show.'
        )
      }
    }
    const result = await client.call<{
      run: {
        id: string
        objective: string
        consumer_generation: number
        legacy: number
        created_at: string
      }
      queue?: RunQueueSummary
    }>('orchestration.runShow', {
      id: getRequiredStringFlag(flags, 'id'),
      ...(queue ? { queue: true, ...(limit !== undefined ? { limit } : {}) } : {})
    })
    printResult(result, json, (r) =>
      r.queue
        ? formatRunQueue(r.run.objective, r.queue)
        : `${r.run.id}${r.run.legacy ? ' [legacy, inspect only]' : ''} ${r.run.objective}\n` +
          `consumer generation ${r.run.consumer_generation}; created ${r.run.created_at}`
    )
  }
}
