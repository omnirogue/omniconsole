import { z } from 'zod'
import { BOARD_TASK_ID_PATTERN } from '../../shared/board-task-id'
import { sessionOutcomeDefinitionSchema } from '../../shared/session-outcome-types'
import type { SessionChain } from '../../shared/session-chain-types'
import type { HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { createOrchestrationCompatibilityEnvelope } from '../runtime/orchestration-compatibility-envelope'

function options(context: HandlerContext) {
  const capability = context.flags.get('dispatch-capability')
  return {
    ...createOrchestrationCompatibilityEnvelope(process.env),
    ...(typeof capability === 'string' ? { orchestrationCapability: capability } : {})
  }
}

async function executionRuntime(context: HandlerContext): Promise<string> {
  const { result } = await context.client.call<{
    executionRuntimeId?: string
    durableContinuation?: boolean
    taskAttachment?: number
    planVersions?: number
  }>('sessionChain.outcomeCapabilities')
  if (
    !result.executionRuntimeId ||
    !result.durableContinuation ||
    result.taskAttachment !== 1 ||
    result.planVersions !== 1
  ) {
    throw new RuntimeClientError(
      'unsupported_capability',
      'Update the execution host to attach or supersede outcomes.'
    )
  }
  return result.executionRuntimeId
}

async function readChain(
  context: HandlerContext,
  expectedExecutionRuntimeId: string
): Promise<SessionChain> {
  const id = context.flags.get('id')
  if (typeof id !== 'string' || !id.trim()) {
    throw new RuntimeClientError('invalid_argument', 'Provide --id <chain-id>.')
  }
  const response = await context.client.call<{ chain: SessionChain }>(
    'sessionChain.outcomeProgress',
    { id, expectedExecutionRuntimeId }
  )
  return response.result.chain
}

export async function attachOutcome(context: HandlerContext): Promise<void> {
  const taskId = z.string().regex(BOARD_TASK_ID_PATTERN).parse(context.flags.get('task'))
  const expectedExecutionRuntimeId = await executionRuntime(context)
  const chain = await readChain(context, expectedExecutionRuntimeId)
  const outcomeId =
    context.flags.get('outcome') ??
    (chain.outcomeSet?.outcomes.length === 1 ? chain.outcomeSet.outcomes[0]!.id : undefined)
  if (typeof outcomeId !== 'string') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Select --outcome <outcome-id> for a chain with multiple outcomes.'
    )
  }
  const result = await context.client.call(
    'sessionChain.attachOutcome',
    {
      expectedExecutionRuntimeId,
      id: chain.id,
      outcomeId,
      taskId,
      expectedRevision: chain.outcomeSet!.revision
    },
    options(context)
  )
  printResult(result, context.json, () => 'Outcome attached to task.')
}

export async function commitUserOutcome(context: HandlerContext, raw: string): Promise<void> {
  const body = z
    .object({
      chain: z.unknown().optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
      outcomes: z.array(sessionOutcomeDefinitionSchema).min(1),
      planVersion: z.number().int().positive().optional()
    })
    .strict()
    .parse(JSON.parse(raw))
  const expectedExecutionRuntimeId = await executionRuntime(context)
  const chain =
    (body.chain as SessionChain | undefined) ??
    (await readChain(context, expectedExecutionRuntimeId))
  const task = context.flags.get('task')
  const supersede = context.flags.get('supersede')
  const result = await context.client.call(
    'sessionChain.commitOutcomes',
    {
      chain,
      expectedExecutionRuntimeId,
      outcomes: body.outcomes,
      expectedRevision: body.expectedRevision ?? chain.outcomeSet?.revision ?? 0,
      ...(task !== undefined
        ? {
            taskRef: {
              taskId: z.string().regex(BOARD_TASK_ID_PATTERN).parse(task),
              attachedAt: Date.now()
            }
          }
        : {}),
      ...(supersede !== undefined
        ? { supersede: { reason: z.string().trim().min(1).parse(supersede) } }
        : {}),
      ...(body.planVersion !== undefined ? { planVersion: body.planVersion } : {}),
      source: 'user'
    },
    options(context)
  )
  printResult(
    result,
    context.json,
    () => 'Outcome set saved. Completion remains conditional on host-verified evidence.'
  )
}
