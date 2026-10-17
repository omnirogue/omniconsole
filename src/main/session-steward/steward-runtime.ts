/**
 * Starts the steward's rules loop on this host (Phase 2): a 60 s pass, plus a pass 2.5 s after any
 * turn finishes, over local sessions only; registers S1's Tier 2 and prompt-limit hooks; and
 * answers the Work card's reads. Every pass is behind the `enabled` switch and
 * `OMNI_STEWARD_DISABLED`; each move is behind its own switch. docs/reference/session-steward.md.
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SessionStewardStatus, StewardResultCard } from '../../shared/session-steward-status'
import { FRESH_PANE_EVIDENCE_FILE } from '../agent-hooks/fresh-pane-evidence-store'
import { onNextStepTurnSignal } from '../next-steps/next-step-suggestion-slot'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { sessionActionsLogFor } from '../session-manage/session-actions-log'
import { setSessionManageEntryAnnotator } from '../session-manage/session-manage-inventory'
import { runtimeDeliveryDeps } from '../session-manage/session-manage-runtime-actions'
import { getSessionPendingDeliveries } from '../session-manage/session-pending-deliveries-runtime'
import { stewardSwitchRefusal } from '../session-manage/session-manage-unattended'
import { setStewardPolicyHooks } from '../session-manage/session-manage-unattended-admission'
import { sessionOrganizationLedgerFor } from '../session-organization/organization-change-ledger'
import { createStewardActions } from './steward-actions'
import { promptsToday } from './steward-caps'
import { emptyStewardPassMemory, runStewardPass, type StewardPassDeps } from './steward-pass'
import { StewardPileupDetector } from './steward-pileup-detector'
import { registerStewardPackageSeams } from './steward-package-seams'
import { createStewardPromptBudget, settleStaleIntents } from './steward-prompt-budget'
import { startFreshPaneEvidence } from './steward-prompted-runtime'
import { StewardResultCardStore } from './steward-result-card'
import { stewardStalledList } from './steward-stalled-waiters'
import {
  createStewardRuntimeSources,
  pendingDeliveryHolds,
  readStewardGitEvidence,
  setStewardHeldDeliverySource
} from './steward-runtime-sources'
import { STEWARD_DIRECTORY, StewardStateStore, stewardDay } from './steward-state-store'
import { stewardFeatureOn, stewardSettings } from './steward-switches'
import { createStewardTier2Check } from './steward-tier2-check'
import { withUnreachableBlankRule } from './steward-remote-blank'
import { configureSshReachabilityLog } from './ssh-reachability-log'

export const STEWARD_PASS_MS = 60_000
export const STEWARD_TURN_SETTLE_MS = 2_500
const FIRST_PASS_MS = 30_000
const DAY_MS = 24 * 60 * 60_000
const ACTIVITY_SHOWN = 100
const FINISHED_SHOWN = 50
/** An archive record this much older than its card still counts (clock skew). */
const CARD_ARCHIVE_SKEW_MS = 60_000

export type SessionStewardHandle = {
  /** One pass now (a pass already running is followed by one more). */
  pass: () => Promise<void>
  status: () => SessionStewardStatus
  /** Result cards whose archive still stands, archived at or after `since`, newest first. */
  finished: (since?: number) => Promise<StewardResultCard[]>
}

let current: SessionStewardHandle | null = null

export function getSessionSteward(): SessionStewardHandle | null {
  return current
}

export function startSessionSteward(options: {
  runtime: OrcaRuntimeService
  store: Store
  userDataPath: string
  now?: () => number
  /** Phase 3 organizing, run after each rules pass (it keeps its own, slower cadence). */
  organize?: () => Promise<unknown>
}): () => Promise<void> {
  const { runtime, userDataPath } = options
  const now = options.now ?? Date.now
  const ledger = () => sessionOrganizationLedgerFor(userDataPath)
  const state = new StewardStateStore({ directory: join(userDataPath, STEWARD_DIRECTORY), now })
  const cards = new StewardResultCardStore(userDataPath)
  const interrupted = state.load()
  if (interrupted.length > 0) {
    void state.transact((data) => settleStaleIntents(data, now(), true)).catch(() => {})
  }
  configureSshReachabilityLog(userDataPath)
  const fresh = startFreshPaneEvidence(
    now,
    join(userDataPath, STEWARD_DIRECTORY, FRESH_PANE_EVIDENCE_FILE)
  )
  const sources = createStewardRuntimeSources({
    runtime,
    store: options.store,
    ledger,
    saveCard: (card) => cards.save(card),
    readCard: (key) => cards.read(key),
    now,
    fresh
  })
  const restoreHooks = setStewardPolicyHooks({
    tier2Eligibility: withUnreachableBlankRule(
      createStewardTier2Check(sources.tier2),
      sources.tier2
    ),
    promptBudget: createStewardPromptBudget({
      store: state,
      now,
      newId: randomUUID,
      readTurnKey: async (source) => (await sources.latestTurn(source)).turnKey,
      readEvidence: (source) => readStewardGitEvidence(runtime, source.worktreeId)
    })
  })
  const restoreAnnotator = setSessionManageEntryAnnotator(sources.annotator(state))
  const restoreHeld = setStewardHeldDeliverySource((paneKey) =>
    pendingDeliveryHolds(getSessionPendingDeliveries(), paneKey)
  )
  const restoreSeams = registerStewardPackageSeams(runtime, cards)
  const deps: StewardPassDeps = {
    ...sources,
    store: state,
    act: createStewardActions({
      delivery: () => runtimeDeliveryDeps(runtime),
      ledger,
      relay: (request) => runtime.requestSessionFolders(request),
      audit: () => sessionActionsLogFor(userDataPath),
      stopWatch: (target) => runtime.watchPaneProcessStop(target.paneKey, target.worktreeId)
    }),
    detector: new StewardPileupDetector({
      now,
      threshold: () => stewardSettings().pileupThreshold,
      // Why a pass later: an admission made before the window has restored its sessions spends
      // one of the day's automatic runs on a list that is not there yet.
      ready: () => passesWithRows > 0,
      note: (summary) => void state.note({ kind: 'cleanup', summary })
    })
  }
  const memory = emptyStewardPassMemory()
  let passesWithRows = 0
  let running: Promise<void> | null = null
  let again = false
  let lastFailure: string | null = null
  const pass = async (): Promise<void> => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        try {
          if (!stewardFeatureOn('enabled')) {
            return
          }
          if (state.read().intents.length > 0) {
            await state.transact((data) => settleStaleIntents(data, now()))
          }
          const result = await runStewardPass(deps, memory)
          passesWithRows += result.rows > 0 ? 1 : 0
          lastFailure = null
        } catch (error) {
          // Why once: no window (a headless relaunch) fails every pass the same way.
          const failure = error instanceof Error ? error.message : String(error)
          if (failure !== lastFailure) {
            lastFailure = failure
            console.warn('[session-steward] pass failed', error)
          }
        }
        // Why after, not inside: organizing runs even when a rules pass failed, and never fails it.
        await options.organize?.().catch((error: unknown) => {
          console.warn('[session-steward] organizing failed', error)
        })
      } finally {
        running = null
        if (again) {
          again = false
          void pass()
        }
      }
    })()
    return running
  }
  const timer = setInterval(() => void pass(), STEWARD_PASS_MS)
  timer.unref?.()
  const first = setTimeout(() => void pass(), FIRST_PASS_MS)
  first.unref?.()
  let settle: ReturnType<typeof setTimeout> | null = null
  const stopSignals = onNextStepTurnSignal((signal) => {
    if (signal.kind !== 'finished' && signal.kind !== 'skip') {
      return
    }
    if (settle) {
      clearTimeout(settle)
    }
    settle = setTimeout(() => void pass(), STEWARD_TURN_SETTLE_MS)
    settle.unref?.()
  })
  const handle: SessionStewardHandle = {
    pass,
    status: () => {
      const data = state.read()
      const at = now()
      return {
        off: stewardSwitchRefusal('enabled'),
        stalled: stewardStalledList(data, memory, sources.stalledWaiters()),
        silent: [...memory.silent].map(([paneKey, silent]) => ({ paneKey, ...silent })),
        activity: data.activity
          .filter((entry) => at - entry.at <= DAY_MS)
          .toReversed()
          .slice(0, ACTIVITY_SHOWN),
        prompts: { today: promptsToday(data.daily, stewardDay(at)) }
      }
    },
    finished: async (since = 0) => {
      const shown: StewardResultCard[] = []
      for (const card of cards.list()) {
        const history = await ledger().history(card.key)
        const last = history.entries.find(
          (record) => record.kind === 'archive' || record.kind === 'unarchive'
        )
        const archivedAt = last ? Date.parse(last.ts) : Number.NaN
        if (
          last?.kind === 'archive' &&
          archivedAt >= card.builtAt - CARD_ARCHIVE_SKEW_MS &&
          archivedAt >= since
        ) {
          shown.push({ ...card, archivedAt, opId: last.opId })
        }
        if (shown.length >= FINISHED_SHOWN) {
          break
        }
      }
      return shown
    }
  }
  current = handle
  return async () => {
    clearInterval(timer)
    clearTimeout(first)
    if (settle) {
      clearTimeout(settle)
    }
    stopSignals()
    fresh.dispose()
    restoreHooks()
    restoreAnnotator()
    restoreHeld()
    restoreSeams()
    if (current === handle) {
      current = null
    }
    await running
    await state.flush()
  }
}
