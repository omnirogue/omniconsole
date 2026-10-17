/**
 * The keeps every sleep, stop or discard re-reads immediately before it acts (G4), in one place
 * so agent hibernation (R1) and the idle rules (R2, R3) read them the same way:
 * G1 an open ask in the pane's own words, G2 a person's touch in the last 10 minutes, G3 on screen,
 * G5 a mid-task agent's restore record. main's half of G1 (Stage A1) is `idleAutoClose.keepReadings`.
 */

import type { AppState } from '@/store/types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  hasOpenAskText,
  IDLE_AUTO_CLOSE_RPC,
  IDLE_RECENT_TOUCH_MS,
  type IdleKeepReading
} from '../../../../shared/idle-auto-close-settings'
import {
  getForegroundTerminalTabIds,
  getForegroundTerminalTabLastSeenAtById
} from '../foreground-terminal-tabs'
import { getAllDrivers, onDriverChange } from '../pane-manager/mobile-driver-state'
import { mergePendingTerminalInputActivity } from '../terminal-input-activity-coalescing'
import { isLiveResumeAnchorForCompletedAgent } from '../live-resume-anchor-record'
import { isTerminalTabRendererVisible } from '../terminal-pane-visibility-registry'
import { getHibernationPaneTouch } from '../agent-hibernation-pane-age'

/**
 * G3. Why the pane's own `isVisibleRef` first: it is the very reading the PTY exit handler wakes a
 * slept pane on (pty-exit-hibernate.ts). Sleeping a pane the page's foreground list missed but the
 * pane itself saw as visible bought a relaunch ~1 s later — 21 kill->create pairs on 2026-09-30.
 */
export function isTerminalTabOnScreen(tabId: string): boolean {
  return isTerminalTabRendererVisible(tabId) || getForegroundTerminalTabIds().includes(tabId)
}

/** The planner's foreground set, from the same predicate as G3. */
export function getOnScreenTerminalTabIds(tabIds: Iterable<string>): string[] {
  const onScreen = new Set(getForegroundTerminalTabIds())
  for (const tabId of tabIds) {
    if (isTerminalTabRendererVisible(tabId)) {
      onScreen.add(tabId)
    }
  }
  return [...onScreen]
}

const personDriverChangeAtByPtyId = new Map<string, number>()
const MAX_REMEMBERED_DRIVER_CHANGES = 2_000
let stopDriverTracking: (() => void) | null = null
let driverTrackingUsers = 0

/** Remembers when a person took or released each PTY (phone or desktop driver). Ref-counted. */
export function startPersonAttachTracking(now: () => number): () => void {
  driverTrackingUsers += 1
  if (!stopDriverTracking) {
    stopDriverTracking = onDriverChange(({ ptyId }) => {
      if (personDriverChangeAtByPtyId.size >= MAX_REMEMBERED_DRIVER_CHANGES) {
        personDriverChangeAtByPtyId.clear()
      }
      personDriverChangeAtByPtyId.set(ptyId, now())
    })
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    driverTrackingUsers -= 1
    if (driverTrackingUsers <= 0) {
      stopDriverTracking?.()
      stopDriverTracking = null
      driverTrackingUsers = 0
    }
  }
}

function finite(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * G2: the newest moment a person revealed the tab, typed into one of its panes or attached to one
 * of its PTYs. A PTY a person drives right now counts as touched now. The stamps the PTY bindings
 * carry across an app restart count too: the window's own memory of them starts empty.
 */
export function lastHumanTouchAt(args: {
  state: Pick<AppState, 'lastTerminalInputAtByPaneKey'>
  tabId: string
  paneKeys: readonly string[]
  ptyIds: readonly string[]
  now: number
}): number {
  const drivers = getAllDrivers()
  let touchAt = finite(getForegroundTerminalTabLastSeenAtById()[args.tabId])
  const inputs = mergePendingTerminalInputActivity(args.state.lastTerminalInputAtByPaneKey)
  for (const paneKey of args.paneKeys) {
    const carried = getHibernationPaneTouch(paneKey)
    touchAt = Math.max(touchAt, finite(inputs[paneKey]), carried.inputAt, carried.revealAt)
  }
  for (const ptyId of args.ptyIds) {
    const driver = drivers.get(ptyId)
    if (driver && driver.kind !== 'idle') {
      return args.now
    }
    touchAt = Math.max(touchAt, finite(personDriverChangeAtByPtyId.get(ptyId)))
  }
  return touchAt
}

/** A touch from the future (a clock change) counts as recent: unknown means keep. */
export function isRecentHumanTouch(touchAt: number, now: number): boolean {
  return touchAt > 0 && now - touchAt < IDLE_RECENT_TOUCH_MS
}

/** G1 from what the window holds: a question card, or a last reply that asks something. */
export function paneHoldsOpenAsk(
  state: Pick<AppState, 'agentStatusByPaneKey' | 'sleepingAgentSessionsByPaneKey'>,
  paneKey: string
): boolean {
  const entry = state.agentStatusByPaneKey[paneKey]
  if (entry?.interactivePrompt) {
    return true
  }
  const replies = [
    entry?.lastAssistantMessageIsToolOutput ? undefined : entry?.lastAssistantMessage,
    entry?.lastCompletedAssistantMessage,
    state.sleepingAgentSessionsByPaneKey[paneKey]?.lastAssistantMessage
  ]
  return replies.some((reply) => hasOpenAskText(reply))
}

/**
 * G5: a 'quit' or 'live' record of an agent that was mid-task. Interrupted restore
 * (restore-interrupted-background-panes.ts) must keep resuming it; no idle rule touches its pane.
 * A completed agent's own live resume anchor (Pi keeps it `working` after done) is not mid-task.
 */
export function isInterruptedRestoreRecord(
  record: SleepingAgentSessionRecord | undefined,
  entry?: AgentStatusEntry
): boolean {
  if (!record || record.state !== 'working') {
    return false
  }
  if (record.origin === 'quit') {
    return true
  }
  return record.origin === 'live' && !isLiveResumeAnchorForCompletedAgent(entry, record)
}

/** main's G1 reading for each pane; an empty answer when main could not be read (keep all). */
export async function readKeepReadingsFromMain(
  targets: { worktreeId: string; paneKey: string }[]
): Promise<IdleKeepReading[]> {
  if (targets.length === 0) {
    return []
  }
  try {
    const result = await callRuntimeRpc<{ readings: IdleKeepReading[] }>(
      { kind: 'local' },
      IDLE_AUTO_CLOSE_RPC.keepReadings,
      { targets: targets.slice(0, 20) },
      { timeoutMs: 15_000 }
    )
    return result.readings
  } catch {
    return []
  }
}

export function resetIdleKeepGuardsForTests(): void {
  stopDriverTracking?.()
  stopDriverTracking = null
  driverTrackingUsers = 0
  personDriverChangeAtByPtyId.clear()
}
