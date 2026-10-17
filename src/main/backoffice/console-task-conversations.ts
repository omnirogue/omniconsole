import { z } from 'zod'
import { ledgerPublicRowSchema } from '../../shared/session-ledger-contract'
import type { ConsoleWorkflowResult, TaskConversation } from '../../shared/console-workflow-types'
import { taskCardRequest } from '../../shared/console-workflow-schemas'
import { requestConsoleWorkflow as request, validated } from './console-workflow-transport'

type LedgerPublicRowParsed = z.infer<typeof ledgerPublicRowSchema>

/** Rows are validated one by one: a malformed row is dropped, the rest still render. */
const conversationRows = z.array(z.unknown()).transform((rows): LedgerPublicRowParsed[] => {
  const kept: LedgerPublicRowParsed[] = []
  for (const row of rows) {
    const parsed = ledgerPublicRowSchema.safeParse(row)
    if (parsed.success) {
      kept.push(parsed.data)
    }
  }
  return kept
})

/**
 * Exactly the `/api/agent-sessions/now` envelope: `overflow` counts rows beyond the
 * page, it is never a total of matching rows, so the header count is `rows.length`
 * plus an honest "+N more" only when the console reports an overflow.
 */
const conversationsAnswer = z
  .object({
    ok: z.boolean().optional(),
    rows: conversationRows,
    overflow: z.number().int().nonnegative().optional()
  })
  .passthrough()

function toTaskConversation(row: LedgerPublicRowParsed): TaskConversation {
  return {
    ledgerId: row.ledger_id,
    employeeName: row.employee_name ?? null,
    agent: row.agent ?? null,
    model: row.model ?? null,
    state: row.state,
    lastActivityAt: row.last_activity_at,
    lastAction: row.last_action ?? null,
    activitySummary: row.activity_summary ?? null
  }
}

/**
 * Every conversation (IDE pane) that "Add to a task" stamped onto this card — the
 * estate session ledger's Task-holds-Conversations read. A second, separate list
 * from the hub's own `taskSessions` (fleet/foreman/bridge runs).
 */
export function readTaskConversations(args: {
  taskId: string
}): Promise<ConsoleWorkflowResult<{ rows: TaskConversation[]; overflow: number }>> {
  return validated(args, taskCardRequest, (input) =>
    request(
      `/api/agent-sessions/by-card/${input.taskId}`,
      'GET',
      conversationsAnswer.transform((answer) => ({
        rows: answer.rows.map(toTaskConversation),
        overflow: answer.overflow ?? 0
      }))
    )
  )
}
