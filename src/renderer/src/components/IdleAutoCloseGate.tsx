import { useEffect } from 'react'
import { useAppStore } from '@/store'
import {
  startIdleAutoCloseCoordinator,
  stopIdleAutoCloseCoordinator
} from '@/lib/idle-auto-close/idle-auto-close-coordinator'
import { getEffectiveIdleAutoCloseMode } from '../../../shared/idle-auto-close-settings'

/** Runs the idle rules R2 and R3 (R1 runs in AgentHibernationGate) unless switched off. */
export function IdleAutoCloseGate(): null {
  const workspaceSessionReady = useAppStore((state) => state.workspaceSessionReady)
  const enabled = useAppStore(
    (state) => getEffectiveIdleAutoCloseMode(state.settings?.idleAutoCloseMode) !== 'off'
  )

  useEffect(() => {
    // Why ready: until reconnect publishes every wake hint, restored tabs look unbound.
    if (!enabled || !workspaceSessionReady) {
      stopIdleAutoCloseCoordinator()
      return
    }
    return startIdleAutoCloseCoordinator()
  }, [enabled, workspaceSessionReady])

  return null
}
