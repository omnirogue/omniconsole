import { useAppStore } from '@/store'
import { useCallback, useEffect, useState } from 'react'
import {
  fetchProviderAccountsSnapshot,
  watchProviderAccounts
} from '@/runtime/runtime-provider-accounts-client'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import type { AgentDetectionTarget } from './useDetectedAgents'

/** Reuse the owning paired runtime's account stream; local usage cannot attest to another machine. */
export function useWorkProviderUsage(target: AgentDetectionTarget | undefined, scope: string) {
  const environmentId = target?.kind === 'runtime' ? target.environmentId : null
  const owner = JSON.stringify([scope, environmentId])
  const [snapshot, setSnapshot] = useState<{ owner: string; rates: RateLimitState | null } | null>(
    null
  )
  useEffect(() => {
    if (!environmentId) {
      return
    }
    const watcher = watchProviderAccounts(
      { activeRuntimeEnvironmentId: environmentId },
      {
        onSnapshot: (value) => setSnapshot({ owner, rates: value.rateLimits }),
        onError: () => setSnapshot({ owner, rates: null })
      }
    )
    return watcher.close
  }, [owner, environmentId])
  const refresh = useCallback(async () => {
    if (!environmentId) {
      return null
    }
    const value = await fetchProviderAccountsSnapshot({ activeRuntimeEnvironmentId: environmentId })
    setSnapshot({ owner, rates: value.rateLimits })
    return value.rateLimits
  }, [owner, environmentId])
  return { rates: snapshot?.owner === owner ? snapshot.rates : null, refresh }
}

const localUsageRefreshes = new Map<string, { at: number; pending: Promise<void> | null }>()

/**
 * Why a surface asks for usage. `open` (a surface mounting, and its timer while it stays open)
 * and `explicit` (a person refreshing) both ask the host to fetch real readings when the ones it
 * holds are stale: the host keeps its own per-provider budget (five minutes for a good reading,
 * Retry-After, failure backoff), so this never forces a provider that answered recently.
 * `explicit` also reads the inactive accounts.
 */
export type WorkUsageRefreshReason = 'open' | 'explicit'

/**
 * Per owner, at most one ask a minute. Why not longer: readings count as current for six
 * minutes and the host refetches a good one after five, so an open surface must ask again
 * within that minute or its agents go unverified between the host's 15-minute polls.
 */
const USAGE_REFRESH_GATE_MS = 60_000

async function fetchStaleReadings(): Promise<void> {
  const state = await window.api.rateLimits.refreshIfStale()
  useAppStore.getState().setRateLimitsFromPush(state)
}

/** All employee surfaces share the existing usage service and one refresh budget. */
export function refreshWorkProviderUsage(
  owner: string,
  reason: WorkUsageRefreshReason = 'open'
): Promise<void> {
  const previous = localUsageRefreshes.get(owner)
  if (previous?.pending) {
    return previous.pending
  }
  const now = Date.now()
  const explicit = reason === 'explicit'
  if (previous && now - previous.at < USAGE_REFRESH_GATE_MS) {
    return useAppStore.getState().fetchRateLimits()
  }
  const entry = { at: now, pending: null as Promise<void> | null }
  entry.pending = (async () => {
    if (explicit) {
      await Promise.allSettled([
        window.api.rateLimits.fetchInactiveClaudeAccounts(),
        window.api.rateLimits.fetchInactiveCodexAccounts()
      ])
    }
    // Why not only `fetchRateLimits`: that re-reads the host's cache, and the host polls every
    // 15 minutes, so a surface opened between polls saw every agent as unverified.
    await fetchStaleReadings().catch(() => useAppStore.getState().fetchRateLimits())
  })().finally(() => {
    entry.pending = null
  })
  localUsageRefreshes.set(owner, entry)
  return entry.pending
}
