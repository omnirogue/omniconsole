import { readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isProviderUsageLimitText } from '../../shared/provider-usage-limit-text'
import { createProviderTranscriptTailReader } from './provider-transcript-tail'

type RecordRow = Record<string, unknown>
const MAX_WORKFLOW_ENTRIES = 128
export type ClaudeWorkflowQuotaFailure = {
  failedAt: number
  reason: string
  childTranscriptPath: string
}

const readRows = createProviderTranscriptTailReader((content): RecordRow[] | null => {
  try {
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const row: unknown = JSON.parse(line)
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw new Error('Invalid record')
        }
        return row as RecordRow
      })
  } catch {
    return null
  }
})

function object(value: unknown): RecordRow | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordRow)
    : undefined
}

function pendingAgents(rows: RecordRow[]): string[] {
  const pending = new Map<string, string>()
  for (const row of rows) {
    if (typeof row.key !== 'string' || typeof row.agentId !== 'string') {
      continue
    }
    if (!/^a[a-z0-9-]{1,127}$/.test(row.agentId)) {
      continue
    }
    if (row.type === 'started') {
      pending.set(row.key, row.agentId)
    } else if (row.type === 'result') {
      pending.delete(row.key)
    }
  }
  return [...new Set(pending.values())]
}

function childFailure(
  rows: RecordRow[],
  sessionId: string,
  agentId: string,
  childTranscriptPath: string
): ClaudeWorkflowQuotaFailure | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (row.type !== 'assistant' && row.type !== 'user') {
      continue
    }
    // A later provider reply or retry supersedes the rejection, including a partial reply.
    if (
      row.type !== 'assistant' ||
      row.isApiErrorMessage !== true ||
      row.sessionId !== sessionId ||
      row.agentId !== agentId ||
      row.isSidechain !== true ||
      !['rate_limit', 'rate_limit_error'].includes(String(row.error))
    ) {
      return null
    }
    const content = object(row.message)?.content
    const text = Array.isArray(content)
      ? content
          .flatMap((block) => {
            const item = object(block)
            return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
          })
          .join(' ')
      : ''
    const quota = object(row.quotaLimits)
    if (
      quota?.resetsAt !== undefined &&
      (typeof quota.resetsAt !== 'number' ||
        !Number.isFinite(quota.resetsAt) ||
        quota.resetsAt * 1_000 <= Date.now())
    ) {
      return null
    }
    const exhausted =
      quota?.status === 'rejected' &&
      (quota.overageDisabledReason === 'out_of_credits' ||
        ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'].includes(
          String(quota.rateLimitType)
        ))
    const failedAt = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
    if (!text || !Number.isFinite(failedAt) || (!exhausted && !isProviderUsageLimitText(text))) {
      return null
    }
    return { failedAt, reason: text.replace(/\s+/g, ' ').slice(0, 1_000), childTranscriptPath }
  }
  return null
}

/** Claude can pause a workflow child on quota without ever failing the parent turn. */
export function readClaudeWorkflowQuotaFailure(
  transcriptPath: string,
  sessionId: string,
  turnStartedAt: number
): ClaudeWorkflowQuotaFailure | null {
  const storageId = basename(transcriptPath, '.jsonl')
  if (!transcriptPath.endsWith('.jsonl') || !/^[a-z0-9_-]{1,128}$/i.test(storageId)) {
    return null
  }
  const parentRows = readRows(transcriptPath)
  if (!parentRows) {
    return null
  }
  let newerThan = turnStartedAt
  for (const row of parentRows) {
    if (row.sessionId !== sessionId || row.isSidechain === true || row.type !== 'user') {
      continue
    }
    const content = object(row.message)?.content
    if (Array.isArray(content) && content.some((item) => object(item)?.type === 'tool_result')) {
      continue
    }
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
    if (!Number.isFinite(at)) {
      return null
    }
    newerThan = Math.max(newerThan, at)
  }
  const children = join(dirname(transcriptPath), storageId, 'subagents')
  const workflows = join(children, 'workflows')
  try {
    const entries = readdirSync(workflows, { withFileTypes: true })
    if (entries.length > MAX_WORKFLOW_ENTRIES) {
      return null
    }
    let latest: ClaudeWorkflowQuotaFailure | null = null
    let childCount = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^wf_[a-z0-9-]+$/.test(entry.name)) {
        continue
      }
      const journal = readRows(join(workflows, entry.name, 'journal.jsonl'))
      if (!journal) {
        continue
      }
      const agents = pendingAgents(journal)
      childCount += agents.length
      if (childCount > MAX_WORKFLOW_ENTRIES) {
        return null
      }
      for (const agentId of agents) {
        const childPath = join(children, `agent-${agentId}.jsonl`)
        const rows = readRows(childPath)
        const failure = rows && childFailure(rows, sessionId, agentId, childPath)
        if (
          failure &&
          failure.failedAt >= newerThan &&
          (!latest || failure.failedAt > latest.failedAt)
        ) {
          latest = failure
        }
      }
    }
    return latest
  } catch {
    return null
  }
}
