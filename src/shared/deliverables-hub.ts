export type DeliverableEntry = {
  relativePath: string
  title: string
  taskId: string | null
  modifiedAt: number
  excerpt: string
}

export type DeliverablesHubResult = {
  root: string
  total: number
  skipped: number
  entries: DeliverableEntry[]
}
