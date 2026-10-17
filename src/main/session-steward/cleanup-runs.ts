/**
 * The cleanup reservation (D7-A): the one gate both the automatic detector and Clean up now pass.
 * One run at a time, for real: a reservation is written durably before any run exists, and it
 * frees only when its run reaches a final status. A run left `dispatching`/`dispatched` by a
 * restart or an unreachable terminal keeps it until the automation service reconciles that run,
 * so doubt never launches a second. Automatic admissions also need the switch, a free daily slot
 * (reservations taken, not runs finished) and capacity on the account the run will use.
 */

import { randomUUID } from 'node:crypto'
import {
  isFinalAutomationRunStatus,
  type Automation,
  type AutomationRun,
  type AutomationRunOptions
} from '../../shared/automations-types'
import type { ProviderAccountCapacitySnapshot } from '../../shared/provider-account-capacity'
import type { Repo } from '../../shared/repo-types'
import {
  CLEANUP_AUTOMATIC_DAILY_CAP,
  type CleanupAdmission,
  type CleanupRefusalReason,
  type CleanupRunSource,
  type CleanupRunsView
} from '../../shared/session-cleanup-run'
import type { SessionManageRendererRequest } from '../../shared/session-manage-relay'
import type { SessionManageUnattended } from '../../shared/session-manage-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeAutomationCreateInput } from '../runtime/omni-runtime'
import { stewardSwitchRefusal } from '../session-manage/session-manage-unattended'
import { cleanupCapacity } from './cleanup-capacity'
import {
  cleanupRunBrief,
  ensureCleanupAutomation,
  findCleanupAutomation
} from './cleanup-automation'
import type {
  LingeringAutomaticCleanupRun,
  LiveAutomaticCleanupRun
} from './cleanup-run-caller-binding'
import { cleanupRunsView } from './cleanup-run-rows'
import { CleanupRunEnds } from './cleanup-run-end'
import {
  bindReservation,
  cleanupPaneContext,
  isReservationRun,
  liveAutomaticCleanupRun,
  lingeringAutomaticCleanupRuns,
  rebuildCleanupState,
  rememberRunPane,
  reservationRun,
  settleReservation
} from './cleanup-reservation-state'
import {
  CleanupReservationStore,
  automaticTakenOn,
  localDay,
  recordCleanupSkip,
  type CleanupReservation,
  type CleanupState,
  type CleanupTaken
} from './cleanup-reservation-store'

export type CleanupRunDeps = {
  statePath: string
  workspacePath: string
  /** No window: nothing could list the sessions or close the run's tab. */
  headless: boolean
  now: () => number
  listAutomations: () => Automation[]
  listRuns: (automationId: string) => AutomationRun[]
  defaultAgent: () => TuiAgent
  addFolderRepo: (path: string, displayName: string) => Promise<Repo>
  createAutomation: (input: RuntimeAutomationCreateInput) => Promise<Automation>
  settleNewWorkspace: () => Promise<void>
  runNow: (automationId: string, options: AutomationRunOptions) => Promise<AutomationRun>
  failRun: (runId: string, error: string) => Promise<unknown>
  relay: (request: SessionManageRendererRequest) => Promise<unknown>
  readCapacity: () => ProviderAccountCapacitySnapshot | null | undefined
  registerPane: (paneKey: string, context: SessionManageUnattended) => () => void
}

export const CLEANUP_NOT_STARTED =
  'OmniConsole stopped before this cleanup run started, so it never ran.'
const HEADLESS_REFUSAL = 'Cleanup runs need the OmniConsole window; this computer runs without one.'

type Refusal = { reason: CleanupRefusalReason; detail: string; why?: string }

export class CleanupRunController {
  private state: CleanupState
  private readonly file: CleanupReservationStore
  /** Reservations whose launch is in flight in this process; no run may exist for them yet. */
  private readonly launching = new Set<string>()
  private readonly panes = new Map<string, () => void>()
  private readonly ends: CleanupRunEnds
  private readonly failing = new Set<string>()

  constructor(private readonly deps: CleanupRunDeps) {
    this.file = new CleanupReservationStore(deps.statePath)
    this.ends = new CleanupRunEnds(deps.relay, (runId) =>
      this.runs().find((run) => run.id === runId)
    )
    const { state, corrupt } = this.file.read()
    this.state = state
    if (corrupt) {
      // Why: an unreadable record is rebuilt from the run history, so a live run keeps its slot.
      const automation = findCleanupAutomation(deps.listAutomations(), undefined)
      this.update(rebuildCleanupState(automation, automation ? deps.listRuns(automation.id) : []))
    }
  }

  /** Startup: settle what a crash left behind and re-register live automatic panes. */
  start(): void {
    this.reconcileActive()
    for (const run of this.runs()) {
      this.notePane(run)
    }
  }

  dispose(): void {
    for (const release of this.panes.values()) {
      release()
    }
    this.panes.clear()
  }

  admit(source: CleanupRunSource, leftovers: readonly string[] = []): CleanupAdmission {
    const now = this.deps.now()
    const off = source === 'automatic' ? this.automaticOff() : null
    if (off) {
      return { ok: false, reason: 'disabled', detail: off }
    }
    this.reconcileActive()
    const active = this.state.active
    if (active) {
      const since = new Date(active.takenAt).toLocaleTimeString()
      return {
        ok: false,
        reason: 'running',
        detail: `${active.source === 'automatic' ? 'An automatic cleanup run' : 'A Clean up now run'} is already going (since ${since}).`
      }
    }
    const refusal = source === 'automatic' ? this.automaticRefusal(now) : null
    if (refusal) {
      this.update(recordCleanupSkip(this.state, { at: now, ...refusal }))
      return { ok: false, reason: refusal.reason, detail: refusal.detail }
    }
    const reservation: CleanupReservation = { reservationId: randomUUID(), source, takenAt: now }
    const taken: CleanupTaken = { ...reservation, day: localDay(now), at: now }
    try {
      this.persist({ ...this.state, active: reservation, taken: [...this.state.taken, taken] })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        reason: 'disabled',
        detail: `The cleanup reservation could not be saved (${reason}), so nothing started.`
      }
    }
    this.launching.add(reservation.reservationId)
    void this.launch(reservation, leftovers)
    return { ok: true, reservationId: reservation.reservationId }
  }

  /** Every dispatch result the automation service writes; must not throw. */
  observe(run: AutomationRun): void {
    try {
      const automation = this.automation()
      if (!automation || run.automationId !== automation.id) {
        return
      }
      const active = this.state.active
      if (active && isReservationRun(active, run)) {
        this.bind(active.reservationId, run)
      }
      this.notePane(run)
      if (!isFinalAutomationRunStatus(run.status)) {
        return
      }
      this.panes.get(run.id)?.()
      this.panes.delete(run.id)
      if (this.state.active?.runId === run.id) {
        this.settle(this.state.active.reservationId, run.status)
      }
      if (run.status === 'completed') {
        this.ends.request(run)
      }
    } catch (error) {
      console.error('[session-cleanup] could not follow a cleanup run:', error)
    }
  }

  retryEnds(): void {
    this.ends.retry()
  }

  view(): CleanupRunsView {
    this.reconcileActive()
    return cleanupRunsView({
      state: this.state,
      history: this.runs(),
      now: this.deps.now(),
      automaticOn: this.automaticOff() === null
    })
  }

  resolvePane(paneKey: string): SessionManageUnattended | null {
    return cleanupPaneContext(this.state, this.runs(), paneKey)
  }

  lingeringAutomaticRuns(): LingeringAutomaticCleanupRun[] {
    return lingeringAutomaticCleanupRuns(this.runs(), this.deps.now())
  }

  liveAutomaticRun(): LiveAutomaticCleanupRun | null {
    return liveAutomaticCleanupRun(this.state, this.runs(), this.automation()?.workspaceId ?? null)
  }

  private async launch(reservation: CleanupReservation, leftovers: readonly string[]) {
    try {
      const automation = await ensureCleanupAutomation(this.deps, this.state.automationId)
      if (this.state.automationId !== automation.id) {
        this.update({ ...this.state, automationId: automation.id })
      }
      const run = await this.deps.runNow(automation.id, {
        promptOverride: cleanupRunBrief(reservation.source, leftovers),
        titleSuffix: reservation.source === 'automatic' ? 'automatic' : 'Clean up now',
        ...(reservation.source === 'automatic' ? { trigger: 'automatic' as const } : {})
      })
      this.launching.delete(reservation.reservationId)
      this.observe(run)
    } catch (error) {
      console.warn('[session-cleanup] the cleanup run did not start:', error)
    } finally {
      this.launching.delete(reservation.reservationId)
      // Why: binds a run created before a throw (and fails it if it never left `pending`).
      this.reconcileActive()
    }
  }

  private automaticOff(): string | null {
    return this.deps.headless ? HEADLESS_REFUSAL : stewardSwitchRefusal('automaticCleanup')
  }

  private automaticRefusal(now: number): Refusal | null {
    const today = automaticTakenOn(this.state, localDay(now))
    if (today >= CLEANUP_AUTOMATIC_DAILY_CAP) {
      return { reason: 'daily-cap', detail: `${today} automatic cleanup runs today` }
    }
    const automation = this.automation()
    const capacity = cleanupCapacity({
      agent: automation?.agentId ?? this.deps.defaultAgent(),
      launchPreferences: automation?.launchPreferences,
      snapshot: this.deps.readCapacity(),
      now
    })
    return capacity.ok ? null : { reason: 'capacity', detail: capacity.detail, why: capacity.why }
  }

  /** Frees the slot once its run is final; a run stuck `pending` after its launch is failed. */
  private reconcileActive(): void {
    const active = this.state.active
    if (!active || this.launching.has(active.reservationId)) {
      return
    }
    const run = reservationRun(active, this.runs())
    if (!run) {
      this.settle(active.reservationId, active.runId ? 'lost' : 'not-started')
      return
    }
    if (!active.runId) {
      this.bind(active.reservationId, run)
    }
    if (isFinalAutomationRunStatus(run.status)) {
      this.settle(active.reservationId, run.status)
    } else if (run.status === 'pending' && !this.failing.has(run.id)) {
      // Why: nothing dispatches a run left pending; failing it is what frees the slot.
      this.failing.add(run.id)
      void this.deps
        .failRun(run.id, CLEANUP_NOT_STARTED)
        .catch((error: unknown) => {
          console.error(
            '[session-cleanup] could not close a cleanup run that never started:',
            error
          )
        })
        .finally(() => this.failing.delete(run.id))
    }
  }

  private notePane(run: AutomationRun): void {
    const paneKey = run.terminalPaneKey
    if (!paneKey || run.trigger !== 'automatic' || isFinalAutomationRunStatus(run.status)) {
      return
    }
    if (!this.panes.has(run.id)) {
      this.panes.set(
        run.id,
        this.deps.registerPane(paneKey, {
          source: 'cleanup-run',
          runId: run.id,
          since: run.createdAt
        })
      )
    }
    const remembered = rememberRunPane(this.state, run.id, paneKey)
    if (remembered) {
      this.update(remembered)
    }
  }

  private bind(reservationId: string, run: AutomationRun): void {
    this.update(bindReservation(this.state, reservationId, run.id))
  }

  private settle(reservationId: string, outcome: NonNullable<CleanupTaken['outcome']>): void {
    this.update(settleReservation(this.state, reservationId, outcome))
  }

  private automation(): Automation | null {
    return findCleanupAutomation(this.deps.listAutomations(), this.state.automationId)
  }

  private runs(): AutomationRun[] {
    const automation = this.automation()
    return automation ? this.deps.listRuns(automation.id) : []
  }

  /** Durable first: an admission that cannot be recorded is not granted. */
  private persist(next: CleanupState): void {
    this.file.write(next)
    this.state = next
  }

  /** Settlements stand even if the file write fails: a restart re-settles from the run store. */
  private update(next: CleanupState): void {
    try {
      this.file.write(next)
    } catch (error) {
      console.error('[session-cleanup] could not save the cleanup record:', error)
    }
    this.state = next
  }
}
