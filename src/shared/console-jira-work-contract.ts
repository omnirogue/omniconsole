import { z } from 'zod'

export const consoleJiraWorkRef = z
  .object({
    provider: z.literal('jira'),
    cloud_id: z.string().uuid(),
    issue_id: z.string().regex(/^[1-9][0-9]{0,31}$/),
    issue_key: z.string().regex(/^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,15}$/),
    project_key: z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/)
  })
  .refine((ref) => ref.issue_key.slice(0, ref.issue_key.lastIndexOf('-')) === ref.project_key)

export const handoffTaskProposal = z.object({
  company_id: z.string(),
  commitment_anchor: z.string(),
  proposed_commitment: z.string(),
  next_check_at: z.string(),
  proposed_delivery_due_at: z.string().nullable().optional(),
  backup_employee_id: z.string().nullable().optional(),
  triage_owner: z.string(),
  decision: z.enum([
    'pending',
    'attach_existing',
    'create_jira',
    'keep_taskless',
    'decline',
    'defer'
  ]),
  creates_task: z.literal(false),
  decision_id: z.string().optional(),
  decided_by: z.string().nullable().optional(),
  decided_at: z.string().nullable().optional()
})

export type ConsoleJiraWorkRef = z.infer<typeof consoleJiraWorkRef>

export function consoleJiraIssueUrl(ref: ConsoleJiraWorkRef): string | null {
  if (ref.cloud_id !== 'bb6f9191-a21a-4857-b965-32de82dce68b') {
    return null
  }
  return `https://example-team.atlassian.net/browse/${encodeURIComponent(ref.issue_key)}`
}
