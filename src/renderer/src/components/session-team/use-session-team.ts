import { useMemo, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { getSessionChain, subscribeSessionChains } from '@/lib/session-chain-registry'
import { selectOrchestrationChildren } from '@/lib/session-row-details'
import {
  buildSessionTeamSummary,
  chainLaunchedPaneKeys,
  type SessionTeamSummary
} from '@/lib/session-team-summary'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SessionChain } from '../../../../shared/session-chain-types'

/**
 * The team around one session — the plan's seats and the live agents filling them — read
 * from state the app already holds: the agent-hook rows and the plan registry. No timer
 * and no request; every surface that shows the team shares this one subscription shape.
 */
export function useSessionTeam(
  session: SidebarSession,
  chainId: string | null
): {
  team: SessionTeamSummary
  entry: AgentStatusEntry | null
  paneKey: string | null
  chain: SessionChain | null
  orchestrationChildren: AgentStatusEntry[]
} {
  // Why: a structured chat row carries no paneKey; its live status is keyed by the structured pane key.
  const paneKey = sidebarSessionSourceIdentity(session)?.sourceKey ?? null
  const entry = useAppStore((state) =>
    paneKey ? state.agentStatusByPaneKey?.[paneKey] : undefined
  )
  const children = useAppStore(
    useShallow((state) => selectOrchestrationChildren(state.agentStatusByPaneKey ?? {}, paneKey))
  )
  const readChain = () => (chainId ? getSessionChain(chainId) : null)
  const chain = useSyncExternalStore(subscribeSessionChains, readChain, readChain)
  const launched = useAppStore(
    useShallow((state) =>
      // useShallow-fresh-ref-ok: every element is the store's own status row, so a
      // re-render with the same rows compares equal even though the array is new.
      chainLaunchedPaneKeys(chain).flatMap((key) => {
        const row = state.agentStatusByPaneKey?.[key]
        return row ? [row] : []
      })
    )
  )
  const team = useMemo(
    () =>
      buildSessionTeamSummary({
        paneKey,
        entry: entry ?? null,
        orchestrationChildren: children,
        chain,
        statusByPaneKey: new Map(launched.map((row) => [row.paneKey, row]))
      }),
    [paneKey, entry, children, chain, launched]
  )
  return { team, entry: entry ?? null, paneKey, chain, orchestrationChildren: children }
}
