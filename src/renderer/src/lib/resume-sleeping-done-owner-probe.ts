import { useAppStore } from '@/store'
import {
  normalizeAgentProviderSession,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { findLiveProviderSessionOwnerWithProbe } from './live-provider-session-owner'

// Why: spec (f) — a resume is skipped only when a LIVE OmniConsole PTY carries the session. A 'done'
// row on a PTY this renderer still holds outlives its agent (the agent exits back to the shell), so
// with no foreground sample either way it proves nothing. The resume sweep skipped such records for
// as long as that shell lived; it now asks the provider what holds the PTY's foreground (the probe
// the reveal gate uses) and resumes the record once the answer is "not the agent".

/** The resume sweep re-run for the sessions a probe settled. */
export type ResumeSweepScope = {
  onlyClaimKeys?: ReadonlySet<string>
  /** A probe found no live owner behind these sessions' unsampled done rows. */
  probeClearedClaimKeys?: ReadonlySet<string>
}

/** Re-run only this session, treating its unsampled done rows as the probe found them: not it. */
export function probeClearedSweepScope(claimKey: string): ResumeSweepScope {
  const keys = new Set([claimKey])
  return { onlyClaimKeys: keys, probeClearedClaimKeys: keys }
}

const probesInFlightByClaimKey = new Set<string>()

/** Probes the done row(s) naming this record's session; calls onCleared when no live owner runs
 *  it. An owner, or a probe that fails, keeps the skip (the record is never deleted here). */
export function probeDoneRowOwnerThenResume(
  record: SleepingAgentSessionRecord,
  claimKey: string,
  excludePaneKey: string,
  onCleared: () => void
): void {
  const providerSession = normalizeAgentProviderSession(record.providerSession)
  if (!providerSession || probesInFlightByClaimKey.has(claimKey)) {
    return
  }
  probesInFlightByClaimKey.add(claimKey)
  const pty = typeof window === 'undefined' ? undefined : window.api?.pty
  const hasPty = (ptyId: string): Promise<boolean | null> =>
    typeof pty?.hasPty === 'function' ? pty.hasPty(ptyId).catch(() => null) : Promise.resolve(null)
  const readForegroundProcess = (ptyId: string): Promise<string | null> =>
    typeof pty?.getForegroundProcess === 'function'
      ? pty.getForegroundProcess(ptyId).catch(() => null)
      : Promise.resolve(null)
  void findLiveProviderSessionOwnerWithProbe(
    useAppStore.getState(),
    { agent: record.agent, providerSession, excludePaneKey },
    hasPty,
    readForegroundProcess
  )
    .catch(() => 'probe-failed')
    .then((owner) => {
      probesInFlightByClaimKey.delete(claimKey)
      if (owner === null) {
        onCleared()
      }
    })
}

export function resetDoneRowOwnerProbesForTests(): void {
  probesInFlightByClaimKey.clear()
}
