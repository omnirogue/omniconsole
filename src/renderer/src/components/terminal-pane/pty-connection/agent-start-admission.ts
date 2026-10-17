import { useAppStore } from '@/store'
import { getPersonRevealedAt, isRestoreFloodGuardOn } from '@/lib/restore-flood-guard'
import { markAgentStartInFlight } from '@/lib/agent-start-in-flight'
import { holdProviderSessionLaunchClaim } from '@/lib/live-provider-session-owner'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Why: main admits at most N agent starts per rolling 10 s app-wide (agent-launch-admission.ts).
// The pane names itself so a person revealing it while its start waits can promote it, asks for
// the priority lane when a person just revealed it, and says "starting…" while it waits. With the
// restore flood guard switched off main queues nothing, so none of this runs (the kill switch
// restores the earlier behavior: no label, no in-flight hold on parking or the paste waiter).

// Why: a phone open marks a tab that may mount a moment later; that start still goes first.
const PERSON_PRIORITY_WINDOW_MS = 30_000
const AGENT_START_LABEL_DELAY_MS = 1_000

export function installAgentStartAdmission(session: ConnectPanePtySession): void {
  session.nextLaunchPriority = null as 'person' | null
  session.agentStartInFlight = false
  const pendingStartReleases = new Set<() => void>()
  /** Pane disposal: its starts no longer hold the tab's in-flight mark or the launch claim. */
  session.releaseAgentStartsInFlight = (): void => {
    for (const release of Array.from(pendingStartReleases)) {
      release()
    }
  }

  /** Spawn options for main's admission window: the pane's key, and the person lane when a
   *  person can see the pane (G3's isVisibleRef) or just revealed it. */
  session.resolveLaunchAdmission = (): {
    launchPriority?: 'person'
    launchAdmissionKey?: string
  } => {
    if (!isRestoreFloodGuardOn(useAppStore.getState().settings)) {
      session.nextLaunchPriority = null
      return {}
    }
    const revealedAt = getPersonRevealedAt(session.deps.tabId)
    const person =
      session.nextLaunchPriority === 'person' ||
      session.deps.isVisibleRef.current === true ||
      (revealedAt !== undefined && Date.now() - revealedAt <= PERSON_PRIORITY_WINDOW_MS)
    session.nextLaunchPriority = null
    return {
      ...(person ? { launchPriority: 'person' as const } : {}),
      launchAdmissionKey: session.cacheKey
    }
  }

  /** "Starting…" on the existing banner surface while an agent start waits (for example in
   *  main's admission queue); returns the settle callback that removes it. */
  session.armAgentStartLabel = (carriesCommand: boolean): (() => void) => {
    if (!carriesCommand || !isRestoreFloodGuardOn(useAppStore.getState().settings)) {
      return () => {}
    }
    session.agentStartInFlight = true
    // Why: while the start waits for a slot the tab has no PTY; waiters (the launch-prompt paste)
    // and the duplicate check (the pane's launch claim) must treat it as starting, not gone.
    const releaseTabInFlight = markAgentStartInFlight(session.deps.tabId)
    const releaseClaimHold = holdProviderSessionLaunchClaim(session.cacheKey)
    const releaseInFlight = (): void => {
      pendingStartReleases.delete(releaseInFlight)
      releaseTabInFlight()
      releaseClaimHold()
    }
    pendingStartReleases.add(releaseInFlight)
    let shown = false
    const timer =
      useAppStore.getState().settings?.launchAdmissionPer10s === 0
        ? null
        : setTimeout(() => {
            if (!session.disposed) {
              shown = true
              session.deps.onShowSessionRestoredBanner(session.pane.id, 'starting')
            }
          }, AGENT_START_LABEL_DELAY_MS)
    return () => {
      session.agentStartInFlight = false
      releaseInFlight()
      if (timer !== null) {
        clearTimeout(timer)
      }
      if (shown) {
        session.deps.onClearSessionRestoredBanner?.(session.pane.id, 'starting')
      }
    }
  }
}
