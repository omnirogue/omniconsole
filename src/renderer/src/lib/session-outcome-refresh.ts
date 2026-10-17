import { useAppStore } from '@/store'
import {
  listSessionOutcomesForOwner,
  reconcileSessionOutcomes
} from '@/components/next-step/next-step-outcome-client'
import {
  sessionOutcomeUnverifiableChain,
  type SessionOutcomeRuntimeTarget
} from '../../../shared/session-outcome-routing'
import {
  getAllSessionChainEntries,
  getSessionChainEntry,
  publishSessionChains,
  setSessionChainEntry,
  subscribeSessionChains
} from './session-chain-registry'
import { outcomeOwnerKey } from './session-outcome-owner'

/** Read-only observation, including owners that have not hydrated a workspace or registry yet. */
export function watchCommittedSessionOutcomes(intervalMs = 2_000): () => void {
  let stopped = false
  const ownerTimers = new Map<string, ReturnType<typeof setTimeout> | null>()
  /** Owners this view is in contact with; losing one and finding it again is a reconnect. */
  const connected = new Set<string>()
  const refreshOwner = async (target: SessionOutcomeRuntimeTarget): Promise<void> => {
    const ownerKey = outcomeOwnerKey(target)
    try {
      const chains = await listSessionOutcomesForOwner(target)
      if (stopped) {
        return
      }
      if (!connected.has(ownerKey)) {
        connected.add(ownerKey)
        // First contact and every reconnect: the host converges now; the next poll reads the result.
        void reconcileSessionOutcomes(target).catch(() => {})
      }
      let changed = false
      for (const chain of chains) {
        const previous = getSessionChainEntry(chain.id, target)?.chain
        if (
          JSON.stringify(previous) === JSON.stringify(chain) ||
          // A seal this view has already read is final; an unsealed copy of that run is stale.
          (previous?.outcomeSet?.completion && !chain.outcomeSet?.completion)
        ) {
          continue
        }
        setSessionChainEntry(chain)
        changed = true
      }
      if (changed) {
        publishSessionChains()
      }
    } catch {
      if (stopped) {
        return
      }
      connected.delete(ownerKey)
      let changed = false
      for (const { chain } of getAllSessionChainEntries()) {
        if (
          !chain.outcomeSet ||
          // Sealed success is terminal evidence: an outage proves nothing against it.
          chain.outcomeSet.completion ||
          outcomeOwnerKey({ hostId: chain.placement ?? chain.hostId ?? 'local' }) !== ownerKey ||
          chain.outcomeSet.continuation.state === 'unverifiable'
        ) {
          continue
        }
        setSessionChainEntry(sessionOutcomeUnverifiableChain(chain))
        changed = true
      }
      if (changed) {
        publishSessionChains()
      }
    }
  }
  const startOwner = (target: SessionOutcomeRuntimeTarget): void => {
    const key = outcomeOwnerKey(target)
    if (ownerTimers.has(key) || stopped) {
      return
    }
    ownerTimers.set(key, null)
    const poll = async (): Promise<void> => {
      await refreshOwner(target)
      if (!stopped) {
        ownerTimers.set(
          key,
          setTimeout(() => {
            void poll()
          }, intervalMs)
        )
      }
    }
    void poll()
  }
  const syncOwners = (): void => {
    startOwner({ kind: 'local' })
    for (const environment of useAppStore.getState().runtimeEnvironments) {
      startOwner({ kind: 'environment', environmentId: environment.id })
    }
    for (const { chain } of getAllSessionChainEntries()) {
      if (!chain.outcomeSet) {
        continue
      }
      const key = outcomeOwnerKey({ hostId: chain.placement ?? chain.hostId ?? 'local' })
      if (key.startsWith('environment:')) {
        startOwner({ kind: 'environment', environmentId: key.slice('environment:'.length) })
      }
    }
  }
  const unsubscribeStore = useAppStore.subscribe?.(syncOwners)
  const unsubscribeRegistry = subscribeSessionChains(syncOwners)
  syncOwners()
  return () => {
    stopped = true
    unsubscribeStore?.()
    unsubscribeRegistry()
    for (const timer of ownerTimers.values()) {
      if (timer) {
        clearTimeout(timer)
      }
    }
    ownerTimers.clear()
  }
}
