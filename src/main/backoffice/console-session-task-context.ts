import { z } from 'zod'
import { consoleWorkflowJson } from '../../shared/console-workflow-schemas'
import type { ConsoleSessionAttachResult } from '../../shared/console-workflow-types'
import { requestConsoleWorkflow as request } from './console-workflow-transport'

const snapshot = z.object({
  card_id: z.string(),
  state_revision: z.number().int().nonnegative(),
  available: z.literal(true),
  status: z.enum(['ready', 'degraded']),
  context: z
    .string()
    .min(1)
    .refine((text) => Buffer.byteLength(text, 'utf8') <= 48_000),
  warnings: z.array(z.string()),
  scope: z.record(z.string(), consoleWorkflowJson).nullable(),
  pack_version: z.union([z.string(), z.number()]),
  replies_waiting: z.array(consoleWorkflowJson),
  dropped_blocks: z.array(consoleWorkflowJson)
})
const revision = z.object({
  task: z.object({ id: z.string(), state_revision: z.number().int().nonnegative() })
})

/** The hub compiles memory; the desktop only checks identity, revision and transport bounds. */
export async function readAttachedTaskContext(
  taskId: string,
  principal: string,
  isCurrent: () => boolean
): Promise<Pick<ConsoleSessionAttachResult, 'context' | 'contextWarning'>> {
  const unavailable = {
    contextWarning:
      'The task is attached, but its shared context is unavailable. Read get_task before continuing.'
  }
  const context = await request(
    `/api/team/tasks/${taskId}/agent-context`,
    'GET',
    snapshot,
    undefined,
    15_000,
    true,
    principal,
    isCurrent
  )
  if (!context.ok || context.data.card_id !== taskId || !isCurrent()) {
    return unavailable
  }
  const current = await request(
    `/api/board/${taskId}/lifecycle`,
    'GET',
    revision,
    undefined,
    15_000,
    false,
    principal,
    isCurrent
  )
  if (
    !current.ok ||
    !isCurrent() ||
    current.data.task.id !== taskId ||
    current.data.task.state_revision !== context.data.state_revision
  ) {
    return unavailable
  }
  return { context: context.data }
}
