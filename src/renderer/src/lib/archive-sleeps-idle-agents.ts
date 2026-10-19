import {
  ARCHIVE_SLEEP_IDLE_MS,
  type ArchiveSleepTrigger
} from '../../../shared/archive-sleep-contract'
import {
  evaluateArchivedPane,
  judgeArchivedPane,
  paneOf,
  type ArchiveSleepDeps,
  type ArchiveSleepEvaluation,
  type ArchiveSleepPending
} from './archive-sleep-evaluate'
import { archiveSleepIdleDueAt } from './archive-sleep-guards'
import {
  archiveSleepLivePtyId,
  archiveSleepVerdict,
  isArchiveSleepSwitchedOff
} from './archive-sleep-verdict'
import { conversationViewKey } from './conversation-view'
import {
  onConversationArchiveChange,
  type ConversationArchiveEvent
} from './session-archive-events'

/**
 * "Archive = pause" (Sal, 30 Sep). A person's archive puts an idle local agent to sleep at once
 * (or when it finishes); an archive from the CLI, a pane's agent, sync, the steward or automatic
 * filing only arms a 30-minute out-of-view idle timer. Every sleep re-checks every keep right
 * before it acts (G4), asks main for its Stage A1 reading, and goes through the row's own "Put to
 * sleep" (a tab-open-only record, so opening the conversation resumes it). Unarchiving first
 * cancels it; nothing on another computer is touched.
 */

export type { ArchiveSleepDeps } from './archive-sleep-evaluate'
export type { ArchiveSleepHost } from './archive-sleep-verdict'

// Why a floor: a due time already past must not spin the timer.
const MIN_TIMER_MS = 1_000

export function createArchiveSleepController(deps: ArchiveSleepDeps) {
  const pending = new Map<string, ArchiveSleepPending>()
  const inFlight = new Set<string>()
  let queue: Promise<void> = Promise.resolve()
  let unsubscribeApp: (() => void) | null = null
  let disposed = false
  let seen: unknown[] = []

  // Why lazy: with nothing armed, no store change pays for this feature.
  const syncSubscription = (): void => {
    if (pending.size > 0 && !unsubscribeApp && !disposed) {
      seen = []
      unsubscribeApp = deps.subscribeApp(onAppState)
    } else if ((pending.size === 0 || disposed) && unsubscribeApp) {
      unsubscribeApp()
      unsubscribeApp = null
    }
  }

  const forget = (paneKey: string): void => {
    pending.get(paneKey)?.cancelTimer?.()
    pending.delete(paneKey)
    syncSubscription()
  }

  const arm = (entry: ArchiveSleepPending, dueAt: number): void => {
    entry.cancelTimer?.()
    entry.cancelTimer = deps.setTimer(
      () => {
        entry.cancelTimer = null
        onTimer(entry)
      },
      Math.max(dueAt - deps.now(), MIN_TIMER_MS)
    )
  }

  const evaluation: ArchiveSleepEvaluation = {
    deps,
    current: (paneKey) => pending.get(paneKey),
    forget,
    retry: (entry, trigger) => {
      if (trigger === 'idle-timer' && pending.get(entry.paneKey) === entry && !entry.cancelTimer) {
        arm(entry, deps.now() + ARCHIVE_SLEEP_IDLE_MS)
      }
    },
    disposed: () => disposed
  }

  // Why one at a time: a bulk archive of many rows reads and stops them in turn, never at once.
  const enqueue = (paneKey: string, trigger: ArchiveSleepTrigger): boolean => {
    if (inFlight.has(paneKey)) {
      return false
    }
    inFlight.add(paneKey)
    queue = queue.then(async () => {
      try {
        await evaluateArchivedPane(evaluation, paneKey, trigger)
      } catch (error) {
        console.warn('[archive-sleeps-idle-agents] evaluation failed', error)
      } finally {
        inFlight.delete(paneKey)
      }
    })
    return true
  }

  function onTimer(entry: ArchiveSleepPending): void {
    if (disposed || pending.get(entry.paneKey) !== entry) {
      return
    }
    const judged = judgeArchivedPane(deps, entry.paneKey)
    if (!judged || judged.verdict.kind === 'drop') {
      forget(entry.paneKey)
      return
    }
    const dueAt = archiveSleepIdleDueAt(
      entry.armedAt,
      judged.status,
      paneOf(entry, judged),
      judged.touch
    )
    if (dueAt > judged.touch.now) {
      arm(entry, dueAt)
    } else if (!enqueue(entry.paneKey, 'idle-timer')) {
      // Why: another check of this pane is running; the timer must not be lost behind it.
      arm(entry, judged.touch.now + ARCHIVE_SLEEP_IDLE_MS)
    }
  }

  function onAppState(): void {
    const state = deps.app()
    const refs = [
      state.agentStatusByPaneKey,
      state.tabsByWorktree,
      state.ptyIdsByTabId,
      state.terminalLayoutsByTabId,
      state.settings
    ]
    if (refs.every((ref, index) => ref === seen[index])) {
      return
    }
    seen = refs
    for (const [paneKey, entry] of Array.from(pending)) {
      const status = state.agentStatusByPaneKey?.[paneKey]
      if (
        isArchiveSleepSwitchedOff(state) ||
        !state.tabsByWorktree?.[entry.worktreeId]?.some((tab) => tab.id === entry.tabId) ||
        (!status && !archiveSleepLivePtyId(state, entry.tabId, paneKey))
      ) {
        forget(paneKey)
        continue
      }
      // Why only a transition: a kept pane is not retried on every store change.
      const finished =
        status?.state === 'done' &&
        (entry.lastState !== 'done' || entry.lastStateStartedAt !== status.stateStartedAt)
      entry.lastState = status?.state ?? null
      entry.lastStateStartedAt = status?.stateStartedAt ?? null
      if (finished && entry.person) {
        enqueue(paneKey, 'done')
      } else if (finished) {
        const touch = deps.touch(state, deps.now())
        const ptyId = archiveSleepLivePtyId(state, entry.tabId, paneKey)
        arm(entry, archiveSleepIdleDueAt(entry.armedAt, status, paneOf(entry, { ptyId }), touch))
      }
    }
    syncSubscription()
  }

  const onUnarchive = (): void => {
    const rows = deps.panes(deps.app())
    const archived = deps.view().archived
    for (const paneKey of Array.from(pending.keys())) {
      const row = rows.find((candidate) => candidate.paneKey === paneKey)
      if (!row || !archived.includes(conversationViewKey(row))) {
        forget(paneKey)
      }
    }
  }

  const onArchiveChange = (event: ConversationArchiveEvent): void => {
    if (disposed) {
      return
    }
    if (!event.archived) {
      onUnarchive()
      return
    }
    const state = deps.app()
    const view = deps.view()
    // Why: before the window restored its workspace and list, nothing here is a new archive.
    if (!view.loaded || state.workspaceSessionReady !== true || isArchiveSleepSwitchedOff(state)) {
      return
    }
    const keys = new Set(event.keys)
    const now = deps.now()
    const touch = deps.touch(state, now)
    const person = event.via === 'person'
    for (const session of deps.panes(state)) {
      const { paneKey, tabId } = session
      if (!paneKey || !tabId || !keys.has(conversationViewKey(session))) {
        continue
      }
      const host = deps.host(state, session.worktreeId)
      const verdict = archiveSleepVerdict({
        state,
        archived: view.archived,
        session,
        host,
        touch,
        protectionKeep: deps.readProtection(
          state,
          { worktreeId: session.worktreeId, tabId, paneKey },
          now,
          { ignoreStartedToday: true }
        )
      })
      if (verdict.kind === 'drop') {
        continue
      }
      // Why each pane: one provider session resumed twice is two agents, each judged alone.
      let entry = pending.get(paneKey)
      if (!entry) {
        const status = state.agentStatusByPaneKey?.[paneKey]
        entry = {
          paneKey,
          worktreeId: session.worktreeId,
          tabId,
          via: event.via,
          person,
          armedAt: now,
          cancelTimer: null,
          lastState: status?.state ?? null,
          lastStateStartedAt: status?.stateStartedAt ?? null
        }
        pending.set(paneKey, entry)
        arm(entry, now + ARCHIVE_SLEEP_IDLE_MS)
      } else if (person) {
        // Why keep armedAt: a repeated archive must not push the idle timer back.
        entry.person = true
        entry.via = 'person'
      }
      if (person && verdict.kind === 'check-host') {
        enqueue(paneKey, 'archive')
      }
    }
    syncSubscription()
  }

  return {
    onArchiveChange,
    onAppState,
    pendingPaneKeys: (): string[] => [...pending.keys()],
    /** Settles once every queued evaluation has run (tests). */
    idle: (): Promise<void> => queue,
    dispose: (): void => {
      disposed = true
      for (const paneKey of Array.from(pending.keys())) {
        forget(paneKey)
      }
    }
  }
}

/** Listens to the window's archive notices; returns the uninstall. */
export function installArchiveSleepController(deps: ArchiveSleepDeps): () => void {
  const controller = createArchiveSleepController(deps)
  const unsubscribe = onConversationArchiveChange(controller.onArchiveChange)
  return () => {
    unsubscribe()
    controller.dispose()
  }
}
