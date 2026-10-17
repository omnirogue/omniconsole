/**
 * One IDE pane whose "Add to a task" stamped this card, from the estate session
 * ledger (`/api/agent-sessions/by-card/{card_id}`). A separate, second list from
 * `ConsoleTaskSession`, which is the hub's own fleet/foreman/bridge runs.
 */
export type TaskConversation = {
  ledgerId: string
  employeeName: string | null
  agent: string | null
  model: string | null
  state: string
  lastActivityAt: string
  lastAction: { kind: string; target: string } | null
  activitySummary: {
    edits?: number
    commits?: number
    tests?: number
    tool_calls?: number
    handoffs?: number
    top_files?: string[]
  } | null
}
