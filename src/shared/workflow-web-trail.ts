import {
  WEB_PAGE_REASON_CODES,
  webPageMediaType,
  type WebPageReason,
  type WebPageReasonCode
} from './web-page-reason'
import type { WorkflowSpec } from './workflow-graph'
import {
  workflowWebShortAddress,
  workflowWebSources,
  type WorkflowWebSource
} from './workflow-graph-web'

/** One page as the run view shows it: never its text or title, which the page wrote. */
export type WorkflowWebTrailSource = {
  id: string
  /** Host and path only (workflowWebShortAddress): never the query, which may carry a key. */
  address: string
  /** `not-kept`: no checked copy (the run ended first, or the copy changed). */
  state: 'read' | 'unreadable' | 'pending' | 'not-kept'
  /** ISO 8601, UTC: when the app read the page. */
  readAt?: string
  /** Why it could not be read; absent when the record names a reason this build does not know. */
  reason?: WebPageReason
  /** Lines the app removed because they read as instructions to an AI. */
  removedLines?: number
  /** The kept text was cut at its limit. */
  truncated?: true
}

export type WorkflowWebTrail = { read: number; sources: WorkflowWebTrailSource[] }

const CODES: ReadonlySet<string> = new Set(WEB_PAGE_REASON_CODES)

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined

// Only the parts the app itself decides: a status the site sent is kept only as a plain number.
function reasonOf(raw: unknown): WebPageReason | undefined {
  const reason = record(raw)
  const code = reason?.code
  if (typeof code !== 'string' || !CODES.has(code)) {
    return undefined
  }
  const status = reason!.status
  const contentType = webPageMediaType(reason!.contentType)
  return {
    code: code as WebPageReasonCode,
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? { status }
      : {}),
    ...(contentType ? { contentType } : {}),
    ...(reason!.limit === 'call' ? { limit: 'call' as const } : {})
  }
}

function keptOf(entry: WorkflowWebSource, kept: unknown): WorkflowWebTrailSource {
  const base = { id: entry.id, address: workflowWebShortAddress(entry.url) }
  const page = record(kept)
  if (page?.state === 'unreadable') {
    const reason = reasonOf(page.reason)
    return { ...base, state: 'unreadable', ...(reason ? { reason } : {}) }
  }
  if (page?.state !== 'read') {
    return { ...base, state: 'not-kept' }
  }
  const readAt = typeof page.fetchedAt === 'string' ? page.fetchedAt : ''
  const removed = page.removedLines
  return {
    ...base,
    state: 'read',
    ...(Number.isFinite(Date.parse(readAt)) ? { readAt } : {}),
    ...(typeof removed === 'number' && Number.isInteger(removed) && removed > 0
      ? { removedLines: removed }
      : {}),
    ...(page.truncated === true ? { truncated: true as const } : {})
  }
}

/** The run's pages from the web call's outcome, read defensively: only a kept page shows as read. */
export function workflowWebTrail(
  spec: Pick<WorkflowSpec, 'steps' | 'oneAnswer'>,
  outcome: unknown,
  active: boolean
): WorkflowWebTrail {
  const sources = workflowWebSources(spec)
  const value = record(record(outcome)?.value)
  const kept = Array.isArray(value?.sources) ? (value.sources as unknown[]) : undefined
  const rows = sources.map((entry): WorkflowWebTrailSource => {
    if (!kept) {
      const state = outcome === undefined && active ? 'pending' : 'not-kept'
      return { id: entry.id, address: workflowWebShortAddress(entry.url), state }
    }
    const page = kept.find(
      (item) => record(item)?.id === entry.id && record(item)?.url === entry.url
    )
    return keptOf(entry, page)
  })
  return { read: rows.filter((row) => row.state === 'read').length, sources: rows }
}
