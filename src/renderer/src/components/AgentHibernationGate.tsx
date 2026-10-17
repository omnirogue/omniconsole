import { useEffect } from 'react'
import { useAppStore } from '@/store'
import {
  startAgentHibernationCoordinator,
  stopAgentHibernationCoordinator
} from '@/lib/agent-hibernation-coordinator'
import { getEffectiveIdleAutoCloseMode } from '../../../shared/idle-auto-close-settings'

export function AgentHibernationGate(): null {
  // Why the idle mode alone: it governs agent sleep, hibernation included ('off' is the kill
  // switch); the coordinator reads which policy applies on every tick.
  const enabled = useAppStore(
    (state) => getEffectiveIdleAutoCloseMode(state.settings?.idleAutoCloseMode) !== 'off'
  )

  useEffect(() => {
    if (!enabled) {
      stopAgentHibernationCoordinator()
      return
    }
    return startAgentHibernationCoordinator()
  }, [enabled])

  return null
}
