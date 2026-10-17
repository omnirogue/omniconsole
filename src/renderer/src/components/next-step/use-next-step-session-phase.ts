import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import { useReturnedMarks } from '@/store/wait-later-store'
import type { AgentStatusState } from '../../../../shared/agent-status-types'

/** The pane facts the status line reads: its hook-reported state and a plan's ↩ Back to me mark. */
export function useNextStepSessionPhaseInput(session: Pick<SidebarSession, 'paneKey'>): {
  agentState: AgentStatusState | null
  returned: boolean
} {
  const { paneKey } = session
  const status = useAppStore((state) =>
    paneKey ? state.agentStatusByPaneKey[paneKey] : undefined
  )
  const returnedAt = useReturnedMarks().get(`pane:${paneKey ?? ''}`)
  // Why: a mark older than the pane's current state belongs to work that has moved on — the
  // same rule the sidebar applies.
  const returned =
    paneKey !== null && returnedAt !== undefined && returnedAt >= (status?.stateStartedAt ?? 0)
  return { agentState: status?.state ?? null, returned }
}
