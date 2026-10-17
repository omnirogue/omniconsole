import { z } from 'zod'
import { consoleJiraWorkRef, type ConsoleJiraWorkRef } from './console-jira-work-contract'

export const jiraTaskId = z.string().regex(/^jira:[a-f0-9-]{36}:[1-9][0-9]{0,31}$/)
export const jiraSessionSource = z.object({ sourceKey: z.string().trim().min(1).max(400) }).strict()
export const jiraSessionAttach = jiraSessionSource.extend({ workRef: consoleJiraWorkRef }).strict()
export const jiraTaskSearch = z
  .object({
    projectKey: z.enum(['APU', 'OMR', 'SWAYB']),
    query: z.string().max(200).optional(),
    cursor: z.string().min(1).max(2048).optional()
  })
  .strict()
export const jiraSessionTask = z.object({
  work_ref: consoleJiraWorkRef,
  summary: z.string().max(1000),
  description_adf: z.unknown().optional(),
  status: z.object({ name: z.string(), id: z.string().optional() }),
  column: z.string(),
  division: z.object({ name: z.string().nullable(), source_label: z.string().nullable() }),
  assignee: z.object({ account_id: z.string(), display_name: z.string() }).nullable(),
  priority: z.string().nullable(),
  due_date: z.string().nullable(),
  updated: z.string()
})
export const jiraSessionTasks = z.object({
  issues: z.array(jiraSessionTask).max(50),
  next_cursor: z.string().nullable().optional(),
  is_last: z.boolean()
})
export const jiraSessionConfig = z.object({
  enabled: z.boolean(),
  projects: z.array(z.object({ key: z.enum(['APU', 'OMR', 'SWAYB']), name: z.string() })),
  connection: z.object({ connected: z.boolean(), detail: z.string().optional() })
})

export type JiraSessionTask = z.infer<typeof jiraSessionTask>
export function jiraSessionTaskId(ref: ConsoleJiraWorkRef): string {
  return `jira:${ref.cloud_id}:${ref.issue_id}`
}
