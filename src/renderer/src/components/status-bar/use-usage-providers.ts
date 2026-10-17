import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import {
  normalizeUsagePercentageDisplay,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { isStatusBarItemAvailable } from './status-bar-agent-gating'
import { getVisibleUsageProvider } from './status-bar-provider-visibility'

type ProviderId = ProviderRateLimits['provider']
type StatusItem = Parameters<typeof isStatusBarItemAvailable>[0]

/** Every usage source the app knows, in the status bar's order. */
const USAGE_SOURCES: { id: ProviderId; key: keyof RateLimitState; item: StatusItem }[] = [
  { id: 'claude', key: 'claude', item: 'claude' },
  { id: 'codex', key: 'codex', item: 'codex' },
  { id: 'gemini', key: 'gemini', item: 'gemini' },
  { id: 'kimi', key: 'kimi', item: 'kimi' },
  { id: 'antigravity', key: 'antigravity', item: 'antigravity' },
  { id: 'minimax', key: 'minimax', item: 'minimax' },
  { id: 'grok', key: 'grok', item: 'grok' },
  { id: 'opencode-go', key: 'opencodeGo', item: 'opencode-go' }
]

/**
 * The usage of every model the person has set up — the same snapshots and the same
 * "is it configured" rules the status bar uses, without the status bar's own
 * per-item visibility choices, so a chat can show all of them in one place.
 */
export function useUsageProviders(activeAgent?: string): {
  providers: ProviderRateLimits[]
  display: UsagePercentageDisplay
  refresh: () => Promise<void>
  isRefreshing: boolean
} {
  const rateLimits = useAppStore((state) => state.rateLimits)
  const settings = useAppStore((state) => state.settings)
  const detectedAgentIds = useAppStore((state) => state.detectedAgentIds)
  const refreshRateLimits = useAppStore((state) => state.refreshRateLimits)
  const display = normalizeUsagePercentageDisplay(
    useAppStore((state) => state.usagePercentageDisplay)
  )
  const [isRefreshing, setIsRefreshing] = useState(false)
  const providers = useMemo(() => {
    const usageSettings = {
      ...settings,
      // Why: Antigravity keeps no credential of its own; a detected CLI is its "set up" signal.
      antigravityUsageConfigured: isStatusBarItemAvailable('antigravity', detectedAgentIds),
      minimaxCookieConfigured: rateLimits.minimaxCookieConfigured,
      grokAuthConfigured: rateLimits.grokAuthConfigured
    }
    const found: ProviderRateLimits[] = []
    for (const source of USAGE_SOURCES) {
      const snapshot = rateLimits[source.key]
      const snapshotProvider =
        snapshot && typeof snapshot === 'object' && 'provider' in snapshot
          ? (snapshot as ProviderRateLimits)
          : null
      const provider = getVisibleUsageProvider(source.id, snapshotProvider, usageSettings)
      // The conversation is evidence of its agent even before local PATH detection settles.
      if (source.id === activeAgent && snapshotProvider) {
        found.push(snapshotProvider)
      } else if (provider && isStatusBarItemAvailable(source.item, detectedAgentIds)) {
        found.push(provider)
      }
    }
    return found
  }, [activeAgent, detectedAgentIds, rateLimits, settings])
  const refresh = useCallback(async () => {
    if (isRefreshing) {
      return
    }
    setIsRefreshing(true)
    try {
      if ((await refreshRateLimits()) === false) {
        throw new Error('Failed to refresh rate limits')
      }
    } finally {
      setIsRefreshing(false)
    }
  }, [isRefreshing, refreshRateLimits])
  return { providers, display, refresh, isRefreshing }
}
