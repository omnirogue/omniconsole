import { openrouterCandidates } from './openrouter-route'
import { z } from 'zod'
import { handoffId } from './console-handoff-contract'
import { taskId } from './console-workflow-schemas'
import type {
  ConsoleLocalExecutionView,
  ConsoleTaskContinuationRequest
} from './console-local-execution'
import type { ConsoleWorkflowResult } from './console-workflow-types'

export type ConsoleTaskContinuationResult =
  | Extract<ConsoleWorkflowResult<ConsoleLocalExecutionView>, { ok: true }>
  | (Extract<ConsoleWorkflowResult<ConsoleLocalExecutionView>, { ok: false }> & {
      launchDisposition: 'not-started' | 'unverifiable'
    })

export const CONSOLE_TASK_CONTINUATION_MAX_INSTRUCTION_CHARS = 32_000

const text = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes('\0'))

export const consoleTaskContinuationRequest: z.ZodType<ConsoleTaskContinuationRequest> = z
  .object({
    operationId: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/),
    taskId,
    goalId: z
      .string()
      .regex(/^cgl_[A-Za-z0-9_-]{1,128}$/)
      .optional(),
    threadId: handoffId.optional(),
    agent: z.enum(['claude', 'codex', 'grok', 'omp']),
    model: text.max(512),
    openrouterCandidates: openrouterCandidates.optional(),
    effort: text.max(128).optional(),
    instruction: z
      .string()
      .min(1)
      .max(CONSOLE_TASK_CONTINUATION_MAX_INSTRUCTION_CHARS)
      .refine((value) => Boolean(value.trim()) && !value.includes('\0')),
    worktree: text.max(4096)
  })
  .strict()
