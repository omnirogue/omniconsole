import { z } from 'zod'
import { taskId } from '../../shared/console-workflow-schemas'
import type {
  ConsoleConversationFleetInventory,
  ConsoleConversationFleetPreview,
  ConsoleConversationFleetTaskContext
} from '../../shared/console-conversation-fleet-types'
import { workflowPreview } from './console-workflow-responses'
import { fleetAccountUsageReceiptSchema } from '../../shared/fleet-account-usage'

const text = z.string().min(1).max(32_000)
const count = z.number().int().nonnegative()
const filing = z.object({
  company_slug: text,
  org_unit_id: text,
  goal_id: text
})
export const conversationFleetInventory: z.ZodType<ConsoleConversationFleetInventory> = z.object({
  ok: z.literal(true),
  providers: z.array(text).max(100),
  models: z
    .array(
      z.object({
        id: text,
        provider: text,
        model: text,
        supported_efforts: z.array(text).max(100),
        default: z.boolean(),
        seat_ready: z.boolean().nullable(),
        aliases: z.array(text).max(100),
        hosts: z.array(text).max(1000).optional()
      })
    )
    .max(2000),
  people: z.array(z.object({ id: text, name: text })).max(2000),
  repositories: z.array(z.object({ id: text })).max(2000),
  models_fallback: z.boolean(),
  machines: z
    .array(
      z.object({
        host: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
        allowed: z.boolean(),
        ready: z.boolean(),
        last_beat: z.string().nullable(),
        slots: count,
        running: count,
        // Why: health arrives from a console release that may be older than this desktop, so
        // each field is accepted when sent and simply absent otherwise.
        cores: count.nullish(),
        load1: z.number().nonnegative().finite().nullish(),
        ratio: z.number().nonnegative().finite().nullish(),
        free_slots: count.nullish(),
        mem_total_bytes: count.nullish(),
        mem_used_bytes: count.nullish(),
        execution_capabilities: z
          .array(
            z
              .object({
                provider: text,
                available: z.boolean(),
                models: z.array(text).max(2000),
                efforts: z.array(text).max(100),
                resume: z.boolean(),
                readonly: z.boolean(),
                native_execution: z.boolean().optional(),
                native_verifier: z.boolean().optional(),
                pinned_task_inputs: z.boolean().optional(),
                source_snapshot: z.boolean().optional(),
                folder_workspace: z.boolean().optional(),
                retained_outputs: z.boolean().optional(),
                account_usage: fleetAccountUsageReceiptSchema.nullable().optional(),
                reason: text.optional()
              })
              .refine(
                (value) =>
                  !value.account_usage?.usage ||
                  value.account_usage.usage.provider === value.provider
              )
          )
          .max(100)
      })
    )
    .max(1000)
})

const taskContext = z.object({
  ok: z.literal(true),
  task_id: taskId,
  expected_revision: count
})
export const conversationFleetTaskContext: z.ZodType<ConsoleConversationFleetTaskContext> =
  z.discriminatedUnion('supported', [
    taskContext.extend({ supported: z.literal(true), filing, reason: text.optional() }),
    taskContext.extend({
      supported: z.literal(false),
      filing: z.object({
        company_slug: text.nullable(),
        org_unit_id: text.nullable(),
        goal_id: text.nullable()
      }),
      reason: text
    })
  ])

export const conversationFleetPreview: z.ZodType<ConsoleConversationFleetPreview> =
  workflowPreview.and(
    z.object({
      admission: z.object({
        task_id: taskId,
        expected_revision: count,
        context_digest: z.string().regex(/^[a-f0-9]{64}$/),
        adopt_stage: z
          .string()
          .regex(/^[a-z][a-z0-9_-]{0,95}$/)
          .nullable()
      }),
      filing,
      reviewer: z.object({ provider: text, model: text.nullable(), effort: text.nullable() })
    })
  )
