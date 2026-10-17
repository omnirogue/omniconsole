import type { RunQueueRow, RunQueueSummary } from '../../../shared/orchestration-run-queue'

function sessionWords(row: RunQueueRow): string {
  if (!row.dispatch) {
    return 'no dispatch'
  }
  // Why two phrases: the Dispatch record and the session are separate facts and may disagree.
  const dispatch = `dispatch ${row.dispatch.id} ${row.dispatch.status} (${row.dispatch.workerState}/${row.dispatch.stage})`
  const where = row.dispatch.server ? ` on ${row.dispatch.server}` : ''
  const session = row.session ? `session ${row.session.status}${where}` : 'session not observed'
  return `${dispatch} · ${session}`
}

function rowLines(row: RunQueueRow): string {
  const attempts = row.attempts > 1 ? ` · attempt ${row.attempts}` : ''
  return `[${row.attention}] ${row.taskId} ${row.title}\n    ${sessionWords(row)}${attempts}\n    ${row.detail}`
}

export function formatRunQueue(objective: string, queue: RunQueueSummary): string {
  const counts = Object.entries(queue.taskCounts)
    .map(([status, total]) => `${total} ${status}`)
    .join(', ')
  const head = [
    `${queue.runId} ${objective}`,
    `Tasks: ${counts || 'none'}. Read ${queue.generatedAt}.`
  ]
  if (queue.rows.length === 0) {
    return [...head, 'Nothing is unfinished.'].join('\n')
  }
  const tail =
    queue.omitted > 0
      ? [`${queue.omitted} more unfinished Task(s) not shown; raise --limit (max 50).`]
      : []
  return [...head, ...queue.rows.map(rowLines), ...tail].join('\n')
}
