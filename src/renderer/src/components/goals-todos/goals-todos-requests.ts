// Which sessions are read, and under which revision. Every surface builds its requests here so
// the shared scheduler sees one revision per session, whichever surface asked.

import type { AppState } from '@/store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import { goalsTodosTranscriptRef } from './goals-todos-reader'
import { goalsTodosKey, type GoalsTodosInput } from './goals-todos-rows'
import type { GoalsTodosReadRequest } from './goals-todos-store'

const LIVE = 'live'
const SAVED = 'saved'

type StatusState = Pick<AppState, 'agentStatusByPaneKey' | 'sleepingAgentSessionsByPaneKey'>

/**
 * One short string per pane: live state and last update, else the saved record's time. Why
 * strings: `useShallow` then re-renders only when a pane's state or time really moved.
 */
export function selectGoalsTodosStatusSignatures(state: StatusState): Record<string, string> {
  const signatures: Record<string, string> = {}
  for (const [paneKey, record] of Object.entries(state.sleepingAgentSessionsByPaneKey ?? {})) {
    signatures[paneKey] = `${SAVED}|${record.updatedAt}`
  }
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey ?? {})) {
    signatures[paneKey] = `${LIVE}|${entry.updatedAt}|${entry.state}`
  }
  return signatures
}

/** The same signature for a single pane, for a surface that follows one session. */
export function goalsTodosStatusSignature(
  state: StatusState,
  paneKey: string | null
): string | undefined {
  if (!paneKey) {
    return undefined
  }
  const entry = state.agentStatusByPaneKey?.[paneKey]
  if (entry) {
    return `${LIVE}|${entry.updatedAt}|${entry.state}`
  }
  const record = state.sleepingAgentSessionsByPaneKey?.[paneKey]
  return record ? `${SAVED}|${record.updatedAt}` : undefined
}

export function goalsTodosInputFor(
  session: SidebarSession,
  signature: string | undefined
): GoalsTodosInput {
  const [kind, at, state] = signature?.split('|') ?? []
  const updatedAt = Number(at)
  const known = Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : null
  return {
    session,
    status:
      kind === LIVE && known !== null
        ? { state: state as AgentStatusState, updatedAt: known }
        : null,
    updatedAt: known
  }
}

/** The read for one session, or null when it has no transcript on this computer. */
export function goalsTodosReadRequest(
  session: SidebarSession,
  signature: string | undefined
): GoalsTodosReadRequest | null {
  const ref = goalsTodosTranscriptRef(session)
  if (!ref) {
    return null
  }
  return {
    key: goalsTodosKey(session),
    revision: `${ref.sessionId}|${signature ?? ''}`,
    ref
  }
}
