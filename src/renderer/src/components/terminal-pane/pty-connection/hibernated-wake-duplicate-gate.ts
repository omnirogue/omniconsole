import { useAppStore } from '@/store'
import { isRestoreFloodGuardOn } from '@/lib/restore-flood-guard'
import {
  collectUnverifiedProviderSessionOwners,
  findLiveProviderSessionOwner,
  type ProviderSessionOwnerQuery
} from '@/lib/live-provider-session-owner'
import {
  normalizeAgentProviderSession,
  type SleepingAgentSessionRecord
} from '../../../../../shared/agent-session-resume'

import { watchProviderSessionOwnerUntilGone } from './provider-session-owner-watch'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

type AppState = ReturnType<typeof useAppStore.getState>

// The hibernation wake (pty-exit-hibernate.ts) resumes the record hibernation wrote; it obeys the
// same duplicate rules as a cold connect: never a second copy of a session a live OmniConsole PTY
// runs (spec f), nor one another pane is starting right now (spec e).

export function installHibernatedWakeDuplicateGate(
  session: ConnectPanePtySession,
  deps: {
    isVisible: () => boolean
    claim: (query: ProviderSessionOwnerQuery | null) => void
    findOwnerWithProbe: (
      state: AppState,
      query: ProviderSessionOwnerQuery
    ) => Promise<string | null>
  }
): () => void {
  const wakeQueryFor = (record: SleepingAgentSessionRecord): ProviderSessionOwnerQuery | null => {
    const providerSession = normalizeAgentProviderSession(record.providerSession)
    return record.agent && providerSession
      ? { agent: record.agent, providerSession, excludePaneKey: session.cacheKey }
      : null
  }
  let wakeProbeClearedFor: SleepingAgentSessionRecord | null = null
  let wakeProbeInFlight = false
  let unwatchWakeOwner: (() => void) | null = null
  const stopWatchingWakeOwner = (): void => {
    unwatchWakeOwner?.()
    unwatchWakeOwner = null
  }
  /** A visible hibernated pane wakes on reveal only; once its session's owner is gone it gets the
   *  wake it was denied (the wake re-reads every guard). */
  const holdWakeAsDuplicate = (record: SleepingAgentSessionRecord): void => {
    session.deps.onShowSessionRestoredBanner(session.pane.id, 'duplicate')
    if (unwatchWakeOwner) {
      return
    }
    unwatchWakeOwner = watchProviderSessionOwnerUntilGone({
      readQuery: () => wakeQueryFor(record),
      stillHeld: () => session.hibernatedWakeTarget?.record === record,
      isDisposed: () => session.disposed === true,
      isVisible: deps.isVisible,
      onGone: () => {
        unwatchWakeOwner = null
        session.deps.onClearSessionRestoredBanner?.(session.pane.id, 'duplicate')
        session.consumeHibernatedAgentWake?.()
      }
    })
  }
  /** True when the wake must wait: another pane owns the session, or a host probe decides and
   *  re-enters the wake once it finds none. Re-read at each wake (G4). */
  session.gateHibernatedWakeDuplicate = (record: SleepingAgentSessionRecord): boolean => {
    const state = useAppStore.getState()
    if (!isRestoreFloodGuardOn(state.settings)) {
      return false
    }
    const query = wakeQueryFor(record)
    if (!query) {
      return false
    }
    const probeCleared = wakeProbeClearedFor === record
    wakeProbeClearedFor = null
    if (findLiveProviderSessionOwner(state, query) !== null) {
      holdWakeAsDuplicate(record)
      return true
    }
    if (probeCleared || collectUnverifiedProviderSessionOwners(state, query).length === 0) {
      return false
    }
    if (!wakeProbeInFlight) {
      wakeProbeInFlight = true
      void deps.findOwnerWithProbe(state, query).then((owner) => {
        wakeProbeInFlight = false
        if (session.disposed) {
          return
        }
        if (owner) {
          holdWakeAsDuplicate(record)
          return
        }
        wakeProbeClearedFor = record
        session.consumeHibernatedAgentWake?.()
      })
    }
    return true
  }
  /** The wake is about to start this session: claim it, so a reveal elsewhere sees it starting
   *  while its start waits in main's admission window. */
  session.claimHibernatedWakeLaunch = (record: SleepingAgentSessionRecord): void => {
    if (!isRestoreFloodGuardOn(useAppStore.getState().settings)) {
      return
    }
    stopWatchingWakeOwner()
    deps.claim(wakeQueryFor(record))
    session.deps.onClearSessionRestoredBanner?.(session.pane.id, 'duplicate')
  }
  return stopWatchingWakeOwner
}
