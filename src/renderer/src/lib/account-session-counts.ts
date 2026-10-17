import type { AppState } from '@/store'
import type { AccountCapacityRow } from '../../../shared/provider-account-capacity'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { parseExecutionHostId } from '../../../shared/execution-host'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import { buildPaneSessions, type SidebarSession } from './sidebar-sessions'
import { shouldReplaceSidebarSession } from './sidebar-session-owner'
import { isExplicitAgentStatusFresh } from './pane-agent-evidence'

export type AccountSessionCount = {
  active: number
  total: number
  unknownActive: boolean
  unknownTotal: boolean
}

function normalizedPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

export function countAccountSessions(
  state: AppState,
  accounts: readonly AccountCapacityRow[],
  archived: readonly string[],
  now = Date.now(),
  sessions: readonly SidebarSession[] = buildPaneSessions(state)
): Record<string, AccountSessionCount> {
  const counts = Object.fromEntries(
    accounts.map((row) => [
      row.choiceId,
      { active: 0, total: 0, unknownActive: false, unknownTotal: false }
    ])
  )
  const seen = new Map<string, { matches: string[]; active: boolean; row: SidebarSession }>()
  const provider = accounts[0]?.provider
  for (const session of sessions) {
    if (
      !session.tabId ||
      session.unavailable ||
      parseExecutionHostId(session.hostId)?.kind !== 'local' ||
      (session.agent !== provider &&
        !(provider === 'claude' && session.agent === 'claude-agent-teams')) ||
      archived.includes(session.sessionKey ?? session.rowKey)
    ) {
      continue
    }
    const paneKey =
      session.paneKey ??
      (session.structuredSessionId
        ? structuredAgentSessionPaneKey(
            structuredAgentSessionTabId(session.structuredSessionId),
            session.structuredSessionId
          )
        : null)
    if (!paneKey) {
      continue
    }
    const status = state.agentStatusByPaneKey[paneKey]
    if (status?.connectionId) {
      continue
    }
    const foreground = state.paneForegroundAgentByPaneKey[paneKey]
    if (foreground?.shellForeground && !foreground.agent) {
      continue
    }
    const variable = provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
    const recordedHome =
      state.agentLaunchConfigByPaneKey[paneKey]?.launchConfig.agentEnv[variable] ??
      state.sleepingAgentSessionsByPaneKey[paneKey]?.launchConfig?.agentEnv[variable]
    const transcript =
      status?.providerSession?.transcriptPath ?? session.providerSession?.transcriptPath
    const matches = accounts
      .filter((account) => {
        const home = account.launchEnv?.[variable]
        if (!home) {
          return false
        }
        return recordedHome
          ? normalizedPath(home) === normalizedPath(recordedHome)
          : Boolean(transcript && normalizedPath(transcript).startsWith(`${normalizedPath(home)}/`))
      })
      .map((account) => account.choiceId)
    const leafId = parsePaneKey(paneKey)?.leafId
    const ptyId = leafId
      ? state.terminalLayoutsByTabId[session.tabId]?.ptyIdsByLeafId?.[leafId]
      : undefined
    const livePty = Boolean(ptyId && state.ptyIdsByTabId[session.tabId]?.includes(ptyId))
    const active = Boolean(
      status?.state === 'working' &&
      status.workingMode !== 'monitoring' &&
      isExplicitAgentStatusFresh(status, now, AGENT_STATUS_STALE_AFTER_MS) &&
      (status.structuredHostOwned || livePty)
    )
    const key = JSON.stringify([
      provider,
      session.providerSession?.id ??
        status?.providerSession?.id ??
        session.structuredSessionId ??
        paneKey
    ])
    const previous = seen.get(key)
    if (shouldReplaceSidebarSession(previous?.row, session, state.agentStatusByPaneKey)) {
      seen.set(key, { matches, active, row: session })
    }
  }
  for (const session of seen.values()) {
    for (const [choiceId, count] of Object.entries(counts)) {
      if (session.matches.includes(choiceId)) {
        count.total++
        if (session.active) {
          count.active++
        }
      } else if (!session.matches.length) {
        count.unknownTotal = true
        count.unknownActive ||= session.active
      }
    }
  }
  return counts
}
