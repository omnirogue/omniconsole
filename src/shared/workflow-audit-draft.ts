import { z } from 'zod'
import { createLocalWorkflowDraft, type LocalWorkflowDraft } from './local-workflow-draft'

/** The host captures the corpus and derives roles and limits; clients cannot supply a snapshot. */
export const localWorkflowAuditDraftSchema = z
  .object({
    version: z.literal(1),
    sourceFile: z.string().trim().min(1).max(32_768),
    format: z.enum(['sources-jsonl', 'digests-jsonl']),
    reference: z
      .object({
        facts: z.string().max(20_000),
        requests: z.string().max(20_000),
        status: z.string().max(20_000)
      })
      .strict()
      .optional()
  })
  .strict()

export type LocalWorkflowAuditDraft = z.infer<typeof localWorkflowAuditDraftSchema>

export function createLocalWorkflowAuditDraft(prompt = ''): LocalWorkflowDraft {
  return {
    ...createLocalWorkflowDraft('discover', prompt),
    audit: { version: 1, sourceFile: '', format: 'sources-jsonl' },
    access: 'frozen',
    runsOn: 'local',
    callLimit: 200,
    maxHostAttempts: 600
  }
}
