import { useState } from 'react'
import { create } from 'zustand'
import { useAppStore } from '@/store'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import {
  getAgentDetectionTargetKeyForWorktree,
  parseAgentDetectionTargetKey
} from '@/hooks/useAgentDetectionTarget'
import { workAgentModelProbeOwner } from '@/hooks/useWorkAgentCapabilities'
import {
  useWorkAgentModelProbes,
  workAgentModelListingPolicy
} from '@/hooks/work-agent-model-probes'
import { sortCapacityRows } from '@/lib/account-capacity-format'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import type { AccountCapacityRow } from '../../../../shared/provider-account-capacity'
import type { ReadyProvider } from '@/store/ready-pane-drafts'

export const useReadyAccountCache = create<{ rows: Record<string, AccountCapacityRow[]> }>(() => ({
  rows: {}
}))
export const readyAccountCacheKey = (scope: string, owner: string, provider: ReadyProvider) =>
  JSON.stringify([scope, owner, provider])

export function readyPaneOwner(worktreeId: string) {
  const state = useAppStore.getState()
  const owner = worktreeId ? getAgentDetectionTargetKeyForWorktree(state, worktreeId) : 'local'
  const settings = state.settings && {
    ...state.settings,
    ...(worktreeId
      ? getSettingsForWorktreeRuntimeOwner(state, worktreeId)
      : { activeRuntimeEnvironmentId: null })
  }
  return { owner, settings, target: parseAgentDetectionTargetKey(owner) }
}

export function useReadyPaneOptions(worktreeId: string, provider: ReadyProvider) {
  const [now] = useState(Date.now)
  const scope = useAppStore(selectConsoleAccountScope)
  const settings = useAppStore((state) => state.settings)
  const rates = useAppStore((state) => state.rateLimits.accountCapacity)
  const probes = useWorkAgentModelProbes((state) => state.probes)
  const cache = useReadyAccountCache((state) => state.rows)
  const resolved = readyPaneOwner(worktreeId)
  const prefix = workAgentModelProbeOwner(scope, JSON.stringify(resolved.target), resolved.settings)
  const probe = probes[`${prefix}:${provider}`]
  const local = resolved.target?.kind === 'local'
  const rows = sortCapacityRows(
    local
      ? (rates?.[provider] ?? [])
      : (cache[readyAccountCacheKey(scope, resolved.owner ?? '', provider)] ?? [])
  )
  const managedId =
    provider === 'claude'
      ? resolved.settings?.activeClaudeManagedAccountId
      : resolved.settings?.activeCodexManagedAccountId
  return {
    models: probe?.models ?? getAgentSessionOptionCatalog(provider)?.models ?? [],
    stale:
      !probe?.models || now - probe.checkedAt > workAgentModelListingPolicy(settings).lifetimeMs,
    rows,
    defaultAccount:
      rows.find((row) => row.isDefault)?.choiceId ??
      (local ? (managedId ? `managed:${managedId}` : 'system') : '__host-default__'),
    defaults: resolved.settings?.conversationLaunchDefaults?.[provider] ?? {},
    owner: resolved.owner
  }
}
