import type { JiraIssue } from '../../../../../shared/jira-types'

export const JIRA_BOARD_COLUMNS = [
  'Backlog',
  'Ready',
  'In Progress',
  'Waiting',
  'Review',
  'Done'
] as const

export type JiraBoardColumn = (typeof JIRA_BOARD_COLUMNS)[number] | 'Other statuses'

const STATUS_COLUMNS: Readonly<Record<string, JiraBoardColumn>> = {
  backlog: 'Backlog',
  proposed: 'Backlog',
  ready: 'Ready',
  approved: 'Ready',
  'in queue': 'Ready',
  planning: 'In Progress',
  'in progress': 'In Progress',
  blocked: 'Waiting',
  waiting: 'Waiting',
  review: 'Review',
  'in review': 'Review',
  done: 'Done'
}

export function groupJiraBoardIssues(
  issues: readonly JiraIssue[]
): Map<JiraBoardColumn, JiraIssue[]> {
  const columns = new Map<JiraBoardColumn, JiraIssue[]>(
    JIRA_BOARD_COLUMNS.map((column) => [column, []])
  )
  for (const issue of issues) {
    // Unknown and cancelled statuses must not silently count as accepted delivery.
    const column = STATUS_COLUMNS[issue.status.name.trim().toLowerCase()] ?? 'Other statuses'
    const items = columns.get(column) ?? []
    items.push(issue)
    columns.set(column, items)
  }
  return columns
}

export function jiraBoardIssueIdentity(issue: JiraIssue): string {
  return JSON.stringify([issue.siteId ?? issue.project.siteId ?? issue.url, issue.id])
}
