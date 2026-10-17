import type { BackofficeTodoItem } from '../../../../shared/backoffice-work-types'

/** The row shape the matcher needs — a structural subset so it stays test-friendly. */
export type AttachTaskSearchRow = {
  taskId: string | null
  title: string
  todo?: Pick<BackofficeTodoItem, 'company_slug' | 'next_action'>
}

/** Resolved company/domain names for the row's filing, from the folder tree the id/slug point at. */
export type AttachTaskSearchNames = {
  companyName?: string | null
  domainName?: string | null
}

/**
 * Case-insensitive, multi-word AND match over title, task id, company slug/name,
 * domain name and the next action, so "apexlabs ads" and "btk_85e6" both narrow.
 */
export function attachTaskRowMatches(
  row: AttachTaskSearchRow,
  query: string,
  names: AttachTaskSearchNames = {}
): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return true
  }
  const haystack = [
    row.title,
    row.taskId,
    row.todo?.company_slug,
    names.companyName,
    names.domainName,
    row.todo?.next_action
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase()
  return words.every((word) => haystack.includes(word))
}
