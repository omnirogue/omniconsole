import { useAppStore } from '@/store'
import {
  isRestoreFloodGuardOn,
  notePersonRevealedTab,
  resetPersonRevealsForTests
} from '@/lib/restore-flood-guard'
import {
  decideBackgroundResume,
  type BackgroundResumeVerdict
} from '@/lib/restore-flood-resume-verdict'
import {
  claimProviderSessionLaunch,
  collectUnverifiedProviderSessionOwners,
  findLiveProviderSessionOwner,
  findLiveProviderSessionOwnerWithProbe,
  type ProviderSessionOwnerQuery
} from '@/lib/live-provider-session-owner'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'

import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import { resolveGateTarget, type GateTarget } from './cold-restore-gate-target'
import { installAgentStartAdmission } from './agent-start-admission'
import { resolvePaneReattachPtyId } from './reattach-candidate-pty'
import { watchProviderSessionOwnerUntilGone } from './provider-session-owner-watch'
import { installHibernatedWakeDuplicateGate } from './hibernated-wake-duplicate-gate'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Why: 2026-09-30 a background mount of one folder workspace resumed 51 finished agents in a
// minute (load ~17, typing lagged). The gate sits before the pane connects: a pane whose agent a
// mount no person asked for must not resume (restore-flood-resume-verdict.ts) holds with NO PTY
// at all — no agent, and no bare login shell that would strand the resume. A person opening the
// tab (or G2, G3, a live interactive ask) releases it and the resume runs as before; a held record
// is never cleared (G1 for a hold). Separately, a pane never resumes a provider session a live
// OmniConsole PTY already runs.

export type ColdRestoreHoldReason = 'held' | 'duplicate'

const revealListenersByTabId = new Map<string, Set<() => void>>()

/** A person opened this tab outside the desktop tab strip (the phone's per-terminal open): a
 *  reveal for this tab only. Its mounted panes re-check their hold now. */
export function revealTerminalTabForPerson(tabId: string, now = Date.now()): void {
  notePersonRevealedTab(tabId, now)
  for (const listener of Array.from(revealListenersByTabId.get(tabId) ?? [])) {
    listener()
  }
}

export function resetColdRestoreRevealHoldForTests(): void {
  resetPersonRevealsForTests()
  revealListenersByTabId.clear()
}

type AppState = ReturnType<typeof useAppStore.getState>

export function installColdRestoreRevealHold(session: ConnectPanePtySession): void {
  session.coldRestoreHoldReason = null as ColdRestoreHoldReason | null
  session.coldRestoreGatePassed = false
  session.releaseProviderSessionClaim = (): void => {}
  installAgentStartAdmission(session)
  // Why isVisibleRef: G3 uses the same live predicate pty-exit-hibernate uses, never a
  // different foreground-tab list.
  const isVisible = (): boolean => session.deps.isVisibleRef.current === true

  const verdictFor = (target: GateTarget, state: AppState): BackgroundResumeVerdict =>
    decideBackgroundResume(state, {
      paneKey: session.cacheKey,
      tabId: session.deps.tabId,
      record: target.record,
      entry: target.entry,
      liveEntryWorking: target.liveEntryWorking,
      liveEntryDriven: target.liveEntryDriven,
      deferredStartup: target.deferredStartup,
      visible: isVisible()
    })

  /** Re-read at the moment of each action (G4); null when nothing here would resume an agent. */
  session.resolveBackgroundResumeVerdict = (): BackgroundResumeVerdict | null => {
    const state = useAppStore.getState()
    const target = resolveGateTarget(session, state)
    return target ? verdictFor(target, state) : null
  }

  /** The hibernation wake (pty-exit-hibernate.ts) for the record hibernation just wrote. */
  session.shouldHoldHibernatedWake = (record: SleepingAgentSessionRecord): boolean =>
    session.deps.attachOnly === true ||
    decideBackgroundResume(useAppStore.getState(), {
      paneKey: session.cacheKey,
      tabId: session.deps.tabId,
      record,
      visible: isVisible()
    }).hold

  let unwatchDuplicateOwner: (() => void) | null = null
  const stopWatchingDuplicateOwner = (): void => {
    unwatchDuplicateOwner?.()
    unwatchDuplicateOwner = null
  }
  const watchDuplicateOwner = (): void => {
    stopWatchingDuplicateOwner()
    unwatchDuplicateOwner = watchProviderSessionOwnerUntilGone({
      readQuery: (state) => resolveGateTarget(session, state)?.query ?? null,
      stillHeld: () => session.coldRestoreHoldReason === 'duplicate',
      isDisposed: () => session.disposed === true,
      isVisible,
      onGone: () => {
        unwatchDuplicateOwner = null
        session.coldRestoreHoldReason = null
        session.deps.onClearSessionRestoredBanner?.(session.pane.id, 'duplicate')
        session.runDeferredConnect()
      }
    })
  }
  const hold = (reason: ColdRestoreHoldReason): void => {
    session.coldRestoreHoldReason = reason
    session.connectStarted = false
    session.deps.onShowSessionRestoredBanner(session.pane.id, reason)
    if (reason === 'duplicate') {
      watchDuplicateOwner()
    } else {
      stopWatchingDuplicateOwner()
    }
  }
  const claim = (query: ProviderSessionOwnerQuery | null): void => {
    session.releaseProviderSessionClaim()
    session.releaseProviderSessionClaim = query
      ? claimProviderSessionLaunch(session.cacheKey, query.agent, query.providerSession)
      : (): void => {}
  }
  const proceed = (): void => {
    if (session.disposed) {
      return
    }
    session.coldRestoreGatePassed = true
    session.connectStarted = false
    session.runDeferredConnect()
  }
  const hasPty = (ptyId: string): Promise<boolean | null> =>
    typeof window.api?.pty?.hasPty === 'function'
      ? window.api.pty.hasPty(ptyId).catch(() => null)
      : Promise.resolve(null)
  const readForegroundProcess = (ptyId: string): Promise<string | null> =>
    typeof window.api?.pty?.getForegroundProcess === 'function'
      ? window.api.pty.getForegroundProcess(ptyId).catch(() => null)
      : Promise.resolve(null)
  const findOwnerWithProbe = (
    state: AppState,
    query: ProviderSessionOwnerQuery
  ): Promise<string | null> =>
    findLiveProviderSessionOwnerWithProbe(state, query, hasPty, readForegroundProcess)

  const stopWatchingWakeOwner = installHibernatedWakeDuplicateGate(session, {
    isVisible,
    claim,
    findOwnerWithProbe
  })

  /** A reattach fallback is about to cold-restore this pane's agent with no connect gate in
   *  between (no PTY id came back, the session expired, the reattach threw, or it adopted an empty
   *  shell left by passive hibernation). Re-read the verdict at that very action (G4): a held pane
   *  holds with no PTY instead of resuming in the background. True when it held. */
  session.holdColdRestoreResumeIfGuarded = (): boolean => {
    if (session.disposed) {
      return false
    }
    const verdict = session.resolveBackgroundResumeVerdict()
    if (!verdict?.hold) {
      return false
    }
    session.releaseProviderSessionClaim()
    session.releaseProviderSessionClaim = (): void => {}
    hold('held')
    return true
  }

  /** After the async probes: re-read every guard (G4), then hold, dedupe, or resume. */
  const decideAfterProbe = async (): Promise<void> => {
    const state = useAppStore.getState()
    const target = resolveGateTarget(session, state)
    if (!target) {
      proceed()
      return
    }
    if (verdictFor(target, state).hold) {
      hold('held')
      return
    }
    const owner = target.query ? await findOwnerWithProbe(state, target.query) : null
    if (session.disposed) {
      return
    }
    if (owner) {
      hold('duplicate')
      return
    }
    claim(target.query)
    proceed()
  }

  /** True when this connect must wait: held with no PTY, or an async probe owns the decision and
   *  re-enters runDeferredConnect once it decides. */
  session.gateColdRestoreConnect = (): boolean => {
    if (session.deps.attachOnly) {
      return false
    }
    if (session.coldRestoreGatePassed) {
      session.coldRestoreGatePassed = false
      return false
    }
    const state = useAppStore.getState()
    if (!isRestoreFloodGuardOn(state.settings)) {
      return false
    }
    const target = resolveGateTarget(session, state)
    if (!target) {
      return false
    }
    const verdict = verdictFor(target, state)
    const { query } = target
    const ownerKnown = query ? findLiveProviderSessionOwner(state, query) !== null : false
    const ownerUnverified = query
      ? collectUnverifiedProviderSessionOwners(state, query).length > 0
      : false
    if (!target.coldRestore) {
      // A lazily restored startup owns no PTY yet: it runs once kept, never as a second copy.
      if (verdict.hold) {
        hold('held')
        return true
      }
      if (ownerKnown) {
        hold('duplicate')
        return true
      }
      if (ownerUnverified) {
        void decideAfterProbe()
        return true
      }
      claim(query)
      return false
    }
    // Why the reattach's own candidate: probing any other PTY (a split sibling's) can pass a held
    // pane as a live reattach that then fresh-spawns its resume. None means gone: the verdict
    // decides.
    let ptyId = resolvePaneReattachPtyId(session, state)
    if (ptyId && isRemoteRuntimePtyId(ptyId)) {
      // Why: pty:hasPty cannot vouch for another host's PTY. A live remote reattach never runs
      // a command, but a slept remote pane is dropped and fresh-spawned, so treat it as gone.
      if (!session.getSleepingRecordForPane(state)) {
        return false
      }
      ptyId = null
    }
    if (!verdict.hold && !ownerKnown && !ownerUnverified) {
      claim(query)
      return false
    }
    void (ptyId ? hasPty(ptyId) : Promise.resolve(false)).then((live) => {
      if (session.disposed) {
        return
      }
      // Why: a PTY that still runs reattaches and main never runs its command. When the reattach
      // finds no PTY or only an empty adopted shell, its fallback re-reads the verdict before any
      // resume (holdColdRestoreResumeIfGuarded). SSH answers unknown until its target reconnects;
      // a held SSH pane stays held, an allowed one goes through the owner check.
      if (live === true) {
        proceed()
        return
      }
      void decideAfterProbe()
    })
    return true
  }

  session.noteRevealed = (): void => {
    if (session.disposed || session.deps.attachOnly) {
      return
    }
    if (session.connectWaitsForTabOpen === true) {
      // Why: a split's slept pane waits for its tab to be opened before it connects
      // (slept-pane-connect-gate.ts). This reveal is that open, from the desktop or the phone's
      // per-terminal open (which never makes the pane visible here); the connect then passes this
      // gate as a person's resume, exactly once.
      session.nextLaunchPriority = 'person'
      session.releaseConnectWaitingForTabOpen()
    } else if (session.coldRestoreHoldReason !== null) {
      const verdict = session.resolveBackgroundResumeVerdict()
      if (!verdict || !verdict.hold || session.coldRestoreHoldReason === 'duplicate') {
        session.coldRestoreHoldReason = null
        session.nextLaunchPriority = 'person'
        session.deps.onClearSessionRestoredBanner?.(session.pane.id)
        session.runDeferredConnect()
      }
    } else if (session.agentStartInFlight) {
      // Why: the pane's start already waits in main's admission window; a person now sees it,
      // so it moves into the priority lane instead of waiting behind the background backlog.
      void window.api?.pty?.promoteAgentLaunch?.(session.cacheKey)?.catch(() => false)
    }
    session.consumeHibernatedAgentWake?.()
  }

  const tabId: string = session.deps.tabId
  const listener = (): void => session.noteRevealed()
  const listeners = revealListenersByTabId.get(tabId) ?? new Set<() => void>()
  listeners.add(listener)
  revealListenersByTabId.set(tabId, listeners)
  session.disposeColdRestoreRevealHold = (): void => {
    listeners.delete(listener)
    if (listeners.size === 0 && revealListenersByTabId.get(tabId) === listeners) {
      revealListenersByTabId.delete(tabId)
    }
    stopWatchingDuplicateOwner()
    stopWatchingWakeOwner()
    session.releaseAgentStartsInFlight()
    session.releaseProviderSessionClaim()
  }
}
