import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { buildSidebarSessions } from '@/lib/sidebar-sessions'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { subscribeAutomationHostInvalidation } from '@/components/automations/automation-host-invalidation-window-events'
import {
  listAutomationsForTarget,
  type AutomationHostTarget
} from '@/components/automations/automation-host-client'
import type { AutomationRun } from '../../../../../shared/automations-types'
import { useRoutineSessionCatalog } from './routine-session-catalog'
import { useRoutineConversations } from './routine-conversation-state'
import { migrateRoutineConversations } from './routine-conversation-migration'
import { routineConversationHost } from './routine-conversation-host'

/** App-scoped ownership survives switching between the two sidebar surfaces. */
export function useRoutineSessionCatalogSync(): void {
  const hydrated = useAppStore((state) => state.hydrationSucceeded && state.persistedUIReady)
  const environments = useAppStore((state) => state.runtimeEnvironments)
  useEffect(() => {
    if (!hydrated) {
      return
    }
    let disposed = false
    const generations = new Map<string, number>()
    const refresh = async (target: AutomationHostTarget) => {
      const key = JSON.stringify(target)
      const generation = (generations.get(key) ?? 0) + 1
      generations.set(key, generation)
      useRoutineSessionCatalog.getState().setCoverage(target, 'loading')
      try {
        const [automations, history] = await Promise.all([
          listAutomationsForTarget(target),
          callRuntimeRpc<{ runs: AutomationRun[] }>(
            target,
            'automation.runs',
            {},
            { timeoutMs: 15_000 }
          )
        ])
        if (disposed || generations.get(key) !== generation) {
          return
        }
        const owners = automations.map((automation) => ({
          automation,
          hostId: routineConversationHost(automation, target),
          sourceTarget: target,
          runs: history.runs.filter((run) => run.automationId === automation.id)
        }))
        useRoutineSessionCatalog.getState().replace(target, owners)
        const liveSessions = buildSidebarSessions(useAppStore.getState())
        useRoutineConversations.getState().reconcile(liveSessions, ['local'])
        await migrateRoutineConversations(owners, liveSessions, target)
        for (const run of history.runs) {
          if (
            run.deliveryVersion === 1 &&
            run.status === 'completed' &&
            !run.deliveryClaims?.alerts
          ) {
            void window.api.alerts
              .deliverRun({
                automationId: run.automationId,
                runId: run.id,
                ...(target.kind === 'environment' ? { environmentId: target.environmentId } : {})
              })
              .catch((error) => console.warn('Routine alert handoff unavailable', error))
          }
        }
      } catch (error) {
        if (!disposed && generations.get(key) === generation) {
          useRoutineSessionCatalog.getState().setCoverage(target, 'unavailable')
        }
        // A failed read cannot revoke ownership or prove a remote session dead.
        console.warn('Routine conversation catalog unavailable', error)
      }
    }
    void refresh({ kind: 'local' })
    for (const environment of environments) {
      void refresh({ kind: 'environment', environmentId: environment.id })
    }
    const unsubscribe = subscribeAutomationHostInvalidation(({ authority }) => {
      void refresh(
        authority.kind === 'runtime'
          ? { kind: 'environment', environmentId: authority.environmentId }
          : { kind: 'local' }
      )
    })
    return () => {
      disposed = true
      unsubscribe()
      for (const key of generations.keys()) {
        useRoutineSessionCatalog.getState().setCoverage(JSON.parse(key), 'unavailable')
      }
    }
  }, [hydrated, environments])
}
