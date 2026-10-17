import { useAppStore } from '@/store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import type { SessionChainSource } from '../../../../shared/session-chain-policy'

/** The session a plan runs after, as the seat that produced the work its first steps read. */
export function useSessionSourceActor(session: SidebarSession | null): SessionChainSource | null {
  const paneKey = session ? (sidebarSessionSourceIdentity(session)?.sourceKey ?? null) : null
  const model = useAppStore((state) =>
    paneKey ? (state.agentStatusByPaneKey?.[paneKey]?.model ?? null) : null
  )
  if (!session?.agent) {
    return null
  }
  return { agent: session.agent, model }
}
