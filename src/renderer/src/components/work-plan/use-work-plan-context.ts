import { useAppStore } from '@/store'
import { useWorkAgentCapabilities } from '@/hooks/useWorkAgentCapabilities'
import type { WorkPlanContext } from '../../../../shared/work-plan-types'

/** Resolve capability probes against the owning workspace, including folders and SSH. */
export function useWorkPlanContext(
  tabId?: string,
  explicitWorktreeId?: string | null
): WorkPlanContext {
  const worktreeId = useAppStore((state) =>
    explicitWorktreeId !== undefined
      ? explicitWorktreeId
      : Object.entries(state.tabsByWorktree ?? {}).find(([, tabs]) =>
        tabs?.some((tab) => tab.id === tabId)
      )?.[0] ?? null
  )
  const availability = useWorkAgentCapabilities(worktreeId)
  return {
    usableAgents: availability.usable.map((entry) => ({
      agent: entry.id,
      models: entry.models.map((model) => ({ id: model.id, label: model.label, efforts: [] }))
    })),
    source: null,
    placement: 'local',
    accountCatalogue: [],
    commitSource: 'user',
    capabilities: { sameConversationRoute: false }
  }
}
