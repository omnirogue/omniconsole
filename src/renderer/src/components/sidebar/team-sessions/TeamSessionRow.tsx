import { lastActionLabel, sessionAgentLabel } from './last-action-label'
import { AgentStateDot, type AgentDotState } from '@/components/AgentStateDot'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { translate } from '@/i18n/i18n'
import type { LedgerPublicRow, LedgerState } from '@/lib/session-ledger-types'

// Running uses working; abandoned uses idle because abandonment does not prove failure.
const dots: Record<LedgerState, AgentDotState> = {
  running: 'working',
  idle: 'idle',
  waiting: 'waiting',
  done: 'done',
  abandoned: 'idle'
}
function stateLabel(state: LedgerState): string {
  switch (state) {
    case 'running':
      return translate('sessionLedger.running', 'Running')
    case 'idle':
      return translate('sessionLedger.idle', 'Idle')
    case 'waiting':
      return translate('sessionLedger.waiting', 'Waiting')
    case 'done':
      return translate('sessionLedger.done', 'Done')
    case 'abandoned':
      return translate('sessionLedger.abandoned', 'Abandoned')
  }
}

export function TeamSessionRow({ row, serverTime }: { row: LedgerPublicRow; serverTime: string }) {
  const workspace =
    row.card_title || (row.repo ? `${row.repo}${row.branch ? `#${row.branch}` : ''}` : null)
  const content = [
    row.employee_name || row.employee_id,
    sessionAgentLabel(row.agent, row.model),
    workspace
  ]
    .filter(Boolean)
    .join(' · ')
  const delta = Date.parse(row.last_activity_at) - Date.parse(serverTime)
  const label = stateLabel(row.state)
  const action = lastActionLabel(row.last_action)
  return (
    <li className="mx-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent" title={action || content}>
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate">{content}</span>
        <span role="img" aria-label={label}>
          <span aria-hidden="true">
            <AgentStateDot state={dots[row.state]} title={label} />
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {Number.isFinite(delta) ? formatUiRelativeTime(delta) : ''}
        </span>
      </div>
      {action ? <div className="truncate text-xs text-muted-foreground">{action}</div> : null}
    </li>
  )
}
