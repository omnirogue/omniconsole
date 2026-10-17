import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { RoutineRunLink } from '../../../shared/routine-run-link'
import { normalizeExecutionHostId } from '../../../shared/execution-host'
export function useRoutineRunLinks(): void {
  const hydrated = useAppStore((state) => state.hydrationSucceeded && state.persistedUIReady)
  useEffect(() => {
    if (!hydrated) {
      return
    }
    let disposed = false
    const show = (target: RoutineRunLink | null) => {
      if (!target || disposed) {
        return
      }
      useAppStore.getState().setPendingAutomationRunNavigation({
        ...target,
        hostId: normalizeExecutionHostId(target.hostId) ?? 'local'
      })
      useAppStore.getState().openAutomationsPage()
    }
    const unsubscribe = window.api.alerts.onOpenRun(show)
    void window.api.alerts.consumePendingOpenRun().then(show)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [hydrated])
}
