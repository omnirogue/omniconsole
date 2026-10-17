import type { useAppStore } from '@/store'
import type { ProviderSessionOwnerQuery } from '@/lib/live-provider-session-owner'
import {
  normalizeAgentProviderSession,
  type SleepingAgentSessionRecord
} from '../../../../../shared/agent-session-resume'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'

import { resolveColdRestoreResumeTarget } from './cold-restore-resume-startup'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

type AppState = ReturnType<typeof useAppStore.getState>

/** What a connect of this pane would resume, as the restore flood guard's gate reads it. */
export type GateTarget = {
  query: ProviderSessionOwnerQuery | null
  /** False for a lazily restored startup: it owns no PTY yet, so there is nothing to reattach. */
  coldRestore: boolean
  record: SleepingAgentSessionRecord | null
  entry: AgentStatusEntry | null
  liveEntryWorking: boolean
  /** A live status row, not a sleeping record, decides whether a mount may resume the agent. */
  liveEntryDriven: boolean
  deferredStartup: boolean
}

export function resolveGateTarget(
  session: ConnectPanePtySession,
  state: AppState
): GateTarget | null {
  const startup = session.paneStartup
  if (startup?.command) {
    // Why: an explicit startup is a person's or a caller's own launch (orchestration, CLI; main's
    // admission paces it); only a lazily restored resume waits for its tab to be opened.
    if (startup.deferUntilRevealed !== true) {
      return null
    }
    const providerSession = normalizeAgentProviderSession(startup.resumeProviderSession)
    return {
      query:
        startup.launchAgent && providerSession
          ? { agent: startup.launchAgent, providerSession, excludePaneKey: session.cacheKey }
          : null,
      coldRestore: false,
      record: session.getSleepingRecordForPane(state)?.record ?? null,
      entry: null,
      liveEntryWorking: false,
      liveEntryDriven: false,
      deferredStartup: true
    }
  }
  const target = resolveColdRestoreResumeTarget(session, state)
  if (!target) {
    return null
  }
  // Why: a non-done row hydrated from last-status.json with no live hook since (restoredUnconfirmed)
  // is no proof the agent is mid-turn or asking. Reading it in place of the sleeping record let
  // every agent that sat 'waiting' or 'blocked' when the app went away skip the guard and resume
  // from the background; with a record at hand, the verdict reads the record.
  const verdictReadsLiveEntry = Boolean(
    target.useLiveEntry && !(target.sleepingRecord && target.entry?.restoredUnconfirmed === true)
  )
  return {
    query: {
      agent: target.agent,
      providerSession: target.providerSession,
      excludePaneKey: session.cacheKey
    },
    coldRestore: true,
    record: verdictReadsLiveEntry ? null : (target.sleepingRecord ?? null),
    entry: target.entry ?? null,
    liveEntryWorking: verdictReadsLiveEntry && target.entry?.state === 'working',
    liveEntryDriven: verdictReadsLiveEntry,
    deferredStartup: false
  }
}
