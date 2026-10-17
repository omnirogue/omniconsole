/**
 * Once per app session, after the workspace session is ready and the settings have loaded: each
 * record the old hibernation wrote (origin 'worktree-sleep', state 'done', not tab-open-only) may
 * take the shape automatic sleep writes now (toAutomaticSleepRecord), so it resumes when its tab
 * is opened instead of on a background mount or a phone wake. On 2026-09-30, 12 such records,
 * several written after their agent had already exited, waited to resume on the next restart.
 *
 * It keeps an agent from resuming, so it is gated like every other rule here: only `on` (with the
 * restore flood guard) rewrites a record; `shadow` writes one would-line per record and changes
 * nothing; `off` (the kill switch) does nothing. Why wait for the settings: before they load they
 * read as shadow, and a saved `off` must win. A record stays on its old wake paths when its pane
 * holds an open ask (G1: the record's and the pane's own words, then main's Stage A1 reading), a
 * person touched it in the last 10 minutes (G2) or its tab is on screen (G3), each re-read
 * immediately before the rewrite (G4). G5: 'quit' and 'live' records are never touched, and
 * neither is a record sharing its conversation with another record (that pairing decides which
 * one resumes).
 */

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import {
  IDLE_RULE,
  keepReasonFromReading,
  resolveIdleAutoCloseGate,
  type IdleAutoCloseGate,
  type IdleKeepReading,
  type IdleKeepReason
} from '../../../shared/idle-auto-close-settings'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { readAgentSleepKeepReadings } from './agent-sleep-guards'
import { recordHibernationLine } from './idle-auto-close/idle-auto-close-audit'
import {
  isRecentHumanTouch,
  isTerminalTabOnScreen,
  lastHumanTouchAt,
  paneHoldsOpenAsk
} from './idle-auto-close/idle-keep-guards'
import { toAutomaticSleepRecord } from './manual-session-sleep'
import { getProviderSessionClaimKey } from './sleeping-agent-pane-ownership'

type PlannedRecord = { paneKey: string; record: SleepingAgentSessionRecord; tabId: string }
type ActiveGate = Exclude<IdleAutoCloseGate, { mode: 'off' }>

let normalizedThisSession = false
let passInFlight: Promise<unknown> = Promise.resolve()

function isLegacyAutomaticSleepRecord(record: SleepingAgentSessionRecord): boolean {
  return (
    record.origin === 'worktree-sleep' &&
    record.state === 'done' &&
    record.restoreOnTabOpenOnly !== true &&
    record.interrupted !== true
  )
}

/** The legacy records with the tab their pane key names; none for 'off'. Keeps not applied yet. */
export function planLegacySleepRecordNormalization(
  state: Pick<AppState, 'settings' | 'sleepingAgentSessionsByPaneKey' | 'tabsByWorktree'>
): PlannedRecord[] {
  if (resolveIdleAutoCloseGate(state.settings).mode === 'off') {
    return []
  }
  const records = state.sleepingAgentSessionsByPaneKey ?? {}
  const recordsByClaim = new Map<string, number>()
  for (const record of Object.values(records)) {
    const claimKey = getProviderSessionClaimKey(record)
    recordsByClaim.set(claimKey, (recordsByClaim.get(claimKey) ?? 0) + 1)
  }
  return Object.entries(records).flatMap(([paneKey, record]) => {
    const tabId = parsePaneKey(paneKey)?.tabId
    const tabExists = (state.tabsByWorktree[record.worktreeId] ?? []).some(
      (tab) => tab.id === tabId
    )
    if (
      !tabId ||
      !tabExists ||
      record.paneKey !== paneKey ||
      (record.tabId !== undefined && record.tabId !== tabId) ||
      !isLegacyAutomaticSleepRecord(record) ||
      recordsByClaim.get(getProviderSessionClaimKey(record)) !== 1
    ) {
      return []
    }
    return [{ paneKey, record, tabId }]
  })
}

/** G3, G2 and G1 from what the window holds, read from `state` as it is now. */
function windowKeepReason(state: AppState, entry: PlannedRecord, now: number): IdleKeepReason | null {
  if (isTerminalTabOnScreen(entry.tabId)) {
    return 'visible'
  }
  const touchAt = lastHumanTouchAt({
    state,
    tabId: entry.tabId,
    paneKeys: [entry.paneKey],
    ptyIds: state.ptyIdsByTabId[entry.tabId] ?? [],
    now
  })
  if (isRecentHumanTouch(touchAt, now)) {
    return 'recent-touch'
  }
  return paneHoldsOpenAsk(state, entry.paneKey) ? 'open-ask' : null
}

function recordLine(
  entry: PlannedRecord,
  gate: ActiveGate,
  outcome: 'would' | 'done' | 'kept',
  keep: IdleKeepReason | 'changed' | null = null
): void {
  const refused = gate.mode === 'shadow' ? gate.refused : undefined
  recordHibernationLine(
    {
      action: 'hibernation.normalize-record',
      target: { paneKey: entry.paneKey, tabId: entry.tabId },
      summary:
        outcome === 'done'
          ? 'An agent the old hibernation put to sleep now resumes only when its tab is opened.'
          : outcome === 'would'
            ? 'Would make an agent the old hibernation put to sleep resume only on opening its tab.'
            : 'Left an agent the old hibernation put to sleep on its old wake paths.',
      audit: {
        rule: IDLE_RULE.NORMALIZE,
        mode: outcome === 'would' ? 'shadow' : gate.mode,
        outcome,
        evidence: {
          worktreeId: entry.record.worktreeId,
          agent: entry.record.agent,
          sleptAt: entry.record.capturedAt,
          ...(keep ? { keep } : {}),
          ...(refused ? { refused } : {})
        }
      }
    },
    `${IDLE_RULE.NORMALIZE}|${entry.paneKey}|${entry.record.capturedAt}|${outcome}`
  )
}

/** main's Stage A1 reading (G1) for each record the window let through; a missing one keeps. */
async function mainKeepReasons(
  entries: readonly PlannedRecord[]
): Promise<Map<string, IdleKeepReason | null>> {
  const readings = await readAgentSleepKeepReadings(
    entries.map((entry) => ({ worktreeId: entry.record.worktreeId, paneKey: entry.paneKey }))
  ).catch(() => new Map<string, IdleKeepReading>())
  return new Map(
    entries.map((entry) => {
      const reading = readings.get(entry.paneKey)
      // Why unlisted keeps: without its sidebar row main cannot read G1 for it.
      return [entry.paneKey, reading?.listed ? keepReasonFromReading(reading) : 'unreadable']
    })
  )
}

function sameGate(a: IdleAutoCloseGate, b: IdleAutoCloseGate): boolean {
  return a.mode === b.mode && a.act === b.act
}

/**
 * One pass: plans the legacy records, applies the window-side keeps, asks main for G1, then (in
 * `on`) rewrites each record still unchanged after its keeps are read once more (G4), or (in
 * shadow) only writes what it would do. Returns how many records were rewritten.
 */
export async function normalizeLegacySleepRecords(
  isCancelled: () => boolean = () => false
): Promise<number> {
  const gate = resolveIdleAutoCloseGate(useAppStore.getState().settings)
  if (gate.mode === 'off') {
    return 0
  }
  const passing: PlannedRecord[] = []
  for (const entry of planLegacySleepRecordNormalization(useAppStore.getState())) {
    const keep = windowKeepReason(useAppStore.getState(), entry, Date.now())
    if (keep) {
      recordLine(entry, gate, 'kept', keep)
    } else {
      passing.push(entry)
    }
  }
  if (passing.length === 0) {
    return 0
  }
  const mainKeeps = await mainKeepReasons(passing)
  // The kill switch, read again after main answered: a mode changed meanwhile ends the pass.
  if (isCancelled() || !sameGate(gate, resolveIdleAutoCloseGate(useAppStore.getState().settings))) {
    return 0
  }
  const toRewrite = passing.filter((entry) => {
    // Why `has`: a null reason (main read it, nothing keeps it) must not read as missing.
    const keep = mainKeeps.has(entry.paneKey) ? mainKeeps.get(entry.paneKey) : 'unreadable'
    if (keep) {
      recordLine(entry, gate, 'kept', keep)
    }
    return !keep
  })
  if (!gate.act) {
    for (const entry of toRewrite) {
      recordLine(entry, gate, 'would')
    }
    return 0
  }
  const written: PlannedRecord[] = []
  const keptNow: [PlannedRecord, IdleKeepReason | 'changed'][] = []
  useAppStore.setState((current) => {
    const next = { ...current.sleepingAgentSessionsByPaneKey }
    for (const entry of toRewrite) {
      // G4: the record unchanged, and G1-G3 read once more, right before this one rewrite.
      const keep =
        next[entry.paneKey] !== entry.record
          ? 'changed'
          : windowKeepReason(current, entry, Date.now())
      if (keep) {
        keptNow.push([entry, keep])
        continue
      }
      next[entry.paneKey] = toAutomaticSleepRecord(entry.record, entry.tabId)
      written.push(entry)
    }
    return written.length > 0 ? { sleepingAgentSessionsByPaneKey: next } : current
  })
  for (const [entry, keep] of keptNow) {
    recordLine(entry, gate, 'kept', keep)
  }
  for (const entry of written) {
    recordLine(entry, gate, 'done')
  }
  return written.length
}

function isReady(state: AppState): boolean {
  return state.workspaceSessionReady && state.settings !== null
}

/** Runs the pass once this app session, once the workspace session is ready and settings loaded. */
export function startLegacySleepRecordNormalization(): () => void {
  if (normalizedThisSession) {
    return () => {}
  }
  let cancelled = false
  let unsubscribe: (() => void) | null = null
  const runWhenReady = (state: AppState): boolean => {
    if (normalizedThisSession || !isReady(state)) {
      return normalizedThisSession
    }
    normalizedThisSession = true
    passInFlight = normalizeLegacySleepRecords(() => cancelled).catch((error: unknown) => {
      console.warn('[agent-hibernation] legacy sleep record pass failed:', error)
    })
    return true
  }
  if (!runWhenReady(useAppStore.getState())) {
    unsubscribe = useAppStore.subscribe((state) => {
      if (runWhenReady(state)) {
        unsubscribe?.()
        unsubscribe = null
      }
    })
  }
  return () => {
    cancelled = true
    unsubscribe?.()
    unsubscribe = null
  }
}

/** Settles once the pass started this session (if any) has finished. */
export function settleLegacySleepRecordPassForTests(): Promise<unknown> {
  return passInFlight
}

export function resetLegacySleepRecordNormalizationForTests(): void {
  normalizedThisSession = false
  passInFlight = Promise.resolve()
}
