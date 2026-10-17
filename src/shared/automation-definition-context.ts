import { normalizeExecutionHostId } from './execution-host'
import { z } from 'zod'
import type { RoutineDeliveryClaims } from './routine-delivery-state'
import type { WorkspaceRunContext } from './task-source-context'

export type AutomationDelivery =
  | { kind: 'chat' }
  | { kind: 'slack'; channel: string }
  | { kind: 'google-drive'; folderId: string }
  | { kind: 'file'; path: string }
  | { kind: 'hub-card'; scope: string }
export type AutomationOutputFormat = 'markdown' | 'html' | 'json' | 'csv' | 'docx' | 'pdf'
export type AutomationAlertChannel =
  | { kind: 'desktop' }
  | { kind: 'slack-dm'; email?: string }
  | { kind: 'slack-channel'; channelId: string; channelName: string }
  | { kind: 'email' }
export type AutomationNotify = {
  onFinish: boolean
  onlyWhenNotable: boolean
  channels: AutomationAlertChannel[]
}
export type AutomationTrigger =
  | { kind: 'schedule' }
  | { kind: 'pull-request'; event: 'opened' | 'closed' | 'merged' }
export type AutomationDefinitionContext = {
  trigger?: AutomationTrigger
  repos?: WorkspaceRunContext[]
  contextPaths?: string[]
  contextNotes?: string
  tools?: { skills: string[]; mcpServers: string[]; allowWrite: boolean }
  scope?: string
  delivery?: AutomationDelivery[]
  outputFormat?: AutomationOutputFormat
  notify?: AutomationNotify
  /** Agent template leading each run's prompt, resolved on the host that runs it; `default` clears. */
  agentTemplateId?: string
  /** The project folder (id) each run joins: it gets the project's brief and is filed there. */
  sessionFolder?: string
}
export type AutomationDeliveryResult = {
  kind: AutomationDelivery['kind'] | AutomationAlertChannel['kind']
  target: string
  ok: boolean
  error?: string
  permalink?: string
}
export type AutomationDeliveryRunFields = {
  deliveryResults?: AutomationDeliveryResult[]
  deliveryClaims?: RoutineDeliveryClaims
  deliveryVersion?: 1
  deliveryHostId?: string | null
  definitionSnapshot?: AutomationRunDefinitionSnapshot
}
const text = z.string().trim().min(1).max(4096)
const scope = z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/)
export const automationDefinitionContextSchema = z.object({
  trigger: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('schedule') }),
      z.object({ kind: z.literal('pull-request'), event: z.enum(['opened', 'closed', 'merged']) })
    ])
    .optional(),
  repos: z
    .array(
      z.object({
        kind: z.literal('workspace-run'),
        projectId: text,
        hostId: text.transform((value, ctx) => {
          const hostId = normalizeExecutionHostId(value)
          if (hostId) {
            return hostId
          }
          ctx.addIssue({ code: 'custom', message: 'Invalid repository host' })
          return z.NEVER
        }),
        projectHostSetupId: text,
        repoId: text,
        path: text
      })
    )
    .max(50)
    .optional(),
  contextPaths: z.array(text).max(200).optional(),
  contextNotes: z
    .string()
    .max(64 * 1024)
    .optional(),
  tools: z
    .object({ skills: z.array(text), mcpServers: z.array(text), allowWrite: z.boolean() })
    .optional(),
  scope: scope.or(z.literal('')).optional(),
  delivery: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('chat') }),
        z.object({ kind: z.literal('slack'), channel: text }),
        z.object({ kind: z.literal('google-drive'), folderId: text }),
        z.object({ kind: z.literal('file'), path: text }),
        z.object({ kind: z.literal('hub-card'), scope })
      ])
    )
    .max(20)
    .optional(),
  outputFormat: z.enum(['markdown', 'html', 'json', 'csv', 'docx', 'pdf']).optional(),
  notify: z
    .object({
      onFinish: z.boolean(),
      onlyWhenNotable: z.boolean(),
      channels: z.array(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('desktop') }),
          z.object({ kind: z.literal('slack-dm'), email: z.string().email().optional() }),
          z.object({
            kind: z.literal('slack-channel'),
            channelId: z.string().max(200),
            channelName: text
          }),
          z.object({ kind: z.literal('email') })
        ])
      )
    })
    .optional(),
  agentTemplateId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional(),
  sessionFolder: z.string().trim().min(1).max(1000).optional()
})

/** Pick only definition fields; drafts and RPC selector fields must never leak into storage. */
export function automationDefinitionContext(
  input: AutomationDefinitionContext
): AutomationDefinitionContext {
  return Object.fromEntries(
    Object.keys(automationDefinitionContextSchema.shape)
      .filter((key) => input[key as keyof AutomationDefinitionContext] !== undefined)
      .map((key) => [key, input[key as keyof AutomationDefinitionContext]])
  )
}

export const DEFAULT_AUTOMATION_NOTIFY: AutomationNotify = {
  onFinish: true,
  onlyWhenNotable: true,
  channels: [{ kind: 'desktop' }]
}
import type { AutomationRunDefinitionSnapshot } from './automation-run-definition'
