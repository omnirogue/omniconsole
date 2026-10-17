import { createRoutineExecutionDelivery } from './routine-run-delivery-coordinator'
import { createFailedAutomationPaneCleanup } from './failed-pane-cleanup'
import type { WebContents } from 'electron'
import type { Store } from '../persistence'
import { assertAutomationRunAllowed } from '../../shared/automation-structured-output'
import {
  type AutomationRunOptions,
  isFinalAutomationRunStatus,
  type Automation,
  type AutomationDispatchResult,
  type AutomationPrecheckResult,
  type AutomationRun
} from '../../shared/automations-types'
import { runScheduledAutomationPrecheck } from './scheduled-run-precheck'
import { resolveAutomationRunTarget, type AutomationRunTargetResult } from './run-target-resolution'
import { recordAutomationCompletionUsage } from './automation-completion-usage'
import { withHeadlessAutomationLaunchProvenance } from './headless-dispatch'
import { clearAutomationDispatchTokens } from './dispatch-tokens'
import { createAutomationDispatchRequest } from './automation-output-binding'
import { runHeadlessAutomationDispatch } from './headless-dispatch-runner'
import { AutomationRunCompletionWatcher } from './run-completion-watcher'
import { createAutomationRunWriter, type AutomationRunWriter } from './automation-run-writer'
import type { AutomationServiceOptions } from './automation-service-options'
import { createAutomationFinalOutputWaiter } from './automation-final-output-wait'
import { recordRefusedAutomationRun, NO_DISPATCH_HOST } from './dispatch-refusal'
import * as occurrence from './scheduled-occurrence'
import * as exclusivity from './routine-run-exclusivity'
import type {
  AutomationsChangedPayload,
  PublishAutomationsChanged
} from '../../shared/runtime-client-events'

type HeadlessDispatcher = NonNullable<AutomationServiceOptions['headlessDispatcher']>

export class AutomationService {
  private readonly closeFailedRun: (run: AutomationRun) => Promise<void>
  private readonly tickMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private webContents: WebContents | null = null
  private rendererReady = false
  private evaluating = false
  private readonly rendererDispatches = exclusivity.createRendererDispatchLedger()
  private readonly waitingLog = occurrence.createWaitingOccurrenceLog()
  private readonly claudeUsage: NonNullable<AutomationServiceOptions['claudeUsage']> | null
  private readonly codexUsage: NonNullable<AutomationServiceOptions['codexUsage']> | null
  private readonly allowRemoteHostScheduling: boolean
  private readonly headlessDispatcher: HeadlessDispatcher | null
  private readonly resolveProjectBrief: AutomationServiceOptions['resolveProjectBrief'] | null
  private readonly publish: PublishAutomationsChanged | null
  onCompletedRun: ((run: AutomationRun) => void) | null = null
  private readonly runObservers = new Set<(run: AutomationRun) => void>()
  private readonly deliverRun: (run: AutomationRun) => void
  private readonly runs: AutomationRunWriter
  private readonly completionWatcher: AutomationRunCompletionWatcher | null
  private readonly finalOutputWaiter: ReturnType<typeof createAutomationFinalOutputWaiter>
  /** Installed by desktop IPC registration, where external probes live; null on
   *  runtime servers. OmniConsole's own automation traffic parks queued external
   *  probes behind this lease, whichever transport carried it. */
  externalProbePriority: (<T>(run: () => T) => T) | null = null

  constructor(
    private readonly store: Store,
    opts: AutomationServiceOptions = {}
  ) {
    this.closeFailedRun = createFailedAutomationPaneCleanup(opts.terminalObserver?.closeRunTerminal)
    this.tickMs = opts.tickMs ?? 60_000
    this.claudeUsage = opts.claudeUsage ?? null
    this.codexUsage = opts.codexUsage ?? null
    this.allowRemoteHostScheduling = opts.allowRemoteHostScheduling ?? false
    this.headlessDispatcher = opts.headlessDispatcher ?? null
    this.resolveProjectBrief = opts.resolveProjectBrief ?? null
    this.publish = opts.onAutomationsChanged ?? null
    this.finalOutputWaiter = createAutomationFinalOutputWaiter(store, opts.resolveFinalOutput)
    this.runs = createAutomationRunWriter(
      store,
      this.publish,
      undefined,
      opts.resolveFinalOutput,
      opts.terminalObserver?.captureTerminalProcessIncarnation
    )
    this.deliverRun = createRoutineExecutionDelivery(store, () =>
      this.publishAutomationsChanged({ reason: 'run' })
    )
    this.completionWatcher = opts.terminalObserver
      ? new AutomationRunCompletionWatcher({
          observer: opts.terminalObserver,
          readRun: (automationId, runId) =>
            this.store.listAutomationRuns(automationId).find((entry) => entry.id === runId) ?? null,
          markDispatchResult: (result) => this.markDispatchResult(result)
        })
      : null
  }

  /** CRUD callers publish through the service so every authority write lands on
   *  the same local + runtime client-event pair. */
  publishAutomationsChanged(payload: AutomationsChangedPayload = {}): void {
    this.publish?.(payload)
  }

  setWebContents(webContents: WebContents | null): void {
    this.completionWatcher?.reconcileRetainedRuns(
      this.rendererDispatches.takeAbandoned(this.store.listAutomationRuns()),
      { strandUnresolved: false }
    )
    this.webContents = webContents
    this.rendererReady = false
  }

  setRendererReady(): void {
    // Reload loses the dispatch reply, not proof that its execution process exited.
    this.completionWatcher?.reconcileRetainedRuns(
      this.rendererDispatches.takeAbandoned(this.store.listAutomationRuns()),
      { strandUnresolved: false }
    )
    this.rendererReady = true
    // Why: the renderer publishes the desktop window graph, so only after it
    // attaches can an unresolvable pane mean a lost terminal rather than "not yet".
    this.completionWatcher?.markTerminalSurfaceReady()
    void this.evaluateDueRuns()
  }

  start(): void {
    if (this.timer) {
      return
    }
    this.finalOutputWaiter.resume()
    this.timer = setInterval(() => {
      void this.evaluateDueRuns()
    }, this.tickMs)
    this.completionWatcher?.reconcileRetainedRuns(this.store.listAutomationRuns())
    // Why: headless serve never gets a renderer-ready IPC, but due runs still
    // need the same startup catch-up pass desktop gets after renderer attach.
    if (this.rendererReady || this.headlessDispatcher) {
      // Serve adopts its daemon PTYs and publishes its graph before start(), so
      // its terminal surface is already as answerable as it will get.
      this.completionWatcher?.markTerminalSurfaceReady()
      void this.evaluateDueRuns()
    }
  }

  stop(): void {
    this.finalOutputWaiter.dispose()
    this.completionWatcher?.dispose()
    if (this.timer) {
      clearInterval(this.timer)
    }
    this.timer = null
  }

  async runNow(automationId: string, options?: AutomationRunOptions): Promise<AutomationRun> {
    const automation = this.store.listAutomations().find((entry) => entry.id === automationId)
    assertAutomationRunAllowed(automation, options?.promptOverride)
    // A second Run now while one is live returns that run instead of launching a duplicate.
    const active = exclusivity.findActiveAutomationRun(this.store.listAutomationRuns(automationId))
    if (active) {
      return active
    }
    const run = this.runs.createRun(automation, Date.now(), options?.trigger ?? 'manual', options)
    return await this.requestDispatch(automation, run, this.resolveTarget(automation))
  }

  /** Every dispatch result as written (dispatched, completed, failed); observers must not throw. */
  observeRuns(observer: (run: AutomationRun) => void): () => void {
    this.runObservers.add(observer)
    return () => void this.runObservers.delete(observer)
  }

  /** The run-history row doc:94 pairs with the typed refusal an execute fence throws. */
  recordRefusedRun(automationId: string): void {
    const automation = this.store.listAutomations().find((entry) => entry.id === automationId)
    if (automation) {
      recordRefusedAutomationRun({
        store: this.store,
        runs: this.runs,
        automation,
        allowRemoteHostScheduling: this.allowRemoteHostScheduling
      })
    }
  }

  async runPrecheck(automationId: string, runId: string): Promise<AutomationPrecheckResult | null> {
    return await runScheduledAutomationPrecheck(this.store, automationId, runId, (automation) =>
      this.resolveTarget(automation)
    )
  }

  async markDispatchResult(result: AutomationDispatchResult): Promise<AutomationRun> {
    const proof = this.finalOutputWaiter.prepare(result)
    if (proof) {
      await proof.ready
    }
    const run = this.runs.updateRun(result, proof?.isCurrent)
    this.runObservers.forEach((observe) => observe(run))
    if (run.status === 'completed') {
      this.deliverRun(run)
      this.onCompletedRun?.(run)
    }
    clearAutomationDispatchTokens(run.automationId, run.id)
    if (!isFinalAutomationRunStatus(run.status)) {
      if (run.status === 'dispatched') {
        this.completionWatcher?.watch(run)
      }
      return run
    }
    this.completionWatcher?.forget(run.id)
    // Why: renderer, headless and watcher completions share one persisted ownership check.
    await this.closeFailedRun(run)
    return recordAutomationCompletionUsage(
      this.store,
      this.runs,
      run,
      this.claudeUsage,
      this.codexUsage
    )
  }

  private async evaluateDueRuns(): Promise<void> {
    if (this.evaluating) {
      return
    }
    this.evaluating = true
    try {
      const now = Date.now()
      for (const automation of this.store.listAutomations()) {
        if (!automation.enabled || automation.nextRunAt > now) {
          continue
        }
        await this.evaluateAutomation(automation, now)
      }
    } finally {
      this.evaluating = false
    }
  }

  private async evaluateAutomation(automation: Automation, now: number): Promise<void> {
    const scheduledFor = this.store.getLatestAutomationOccurrence(automation, now)
    if (scheduledFor === null) {
      this.store.advanceAutomationNextRun(automation.id, now)
      return
    }
    // Resolved before the run exists: a refusal repeats every occurrence, and a
    // */5 automation would otherwise write ~288 identical rows a day — past
    // retention, which would evict the automation's real history.
    const target = this.resolveTarget(automation)
    const decision = occurrence.decideScheduledOccurrence({
      lateMs: now - scheduledFor,
      graceMs: occurrence.effectiveMissedRunGraceMs(automation, this.tickMs),
      target,
      // Headless serve counts: it launches runs with no window at all.
      canDispatch: this.canDispatchToRenderer() || Boolean(this.headlessDispatcher)
    })
    if (decision.kind === 'wait') {
      this.waitingLog.waiting(automation.id, scheduledFor)
      return
    }
    this.waitingLog.settled(automation.id)
    if (occurrence.settleScheduledOccurrence(this.runs, automation, scheduledFor, decision)) {
      this.store.advanceAutomationNextRun(automation.id, now)
      return
    }
    const { status } = await exclusivity.dispatchScheduledOccurrence({
      automation,
      scheduledFor,
      history: this.store.listAutomationRuns(automation.id),
      runs: this.runs,
      launchable: target.ok && (this.canDispatchToRenderer() || Boolean(this.headlessDispatcher)),
      dispatch: (run) => this.requestDispatch(automation, run, target)
    })
    console.info('[automations] scheduled occurrence', automation.id, scheduledFor, status)
    this.store.advanceAutomationNextRun(automation.id, now)
  }

  private resolveTarget(automation: Automation): AutomationRunTargetResult {
    return resolveAutomationRunTarget(this.store, automation, {
      allowRemoteHostScheduling: this.allowRemoteHostScheduling
    })
  }

  private canDispatchToRenderer(): boolean {
    const webContents = this.webContents
    return Boolean(webContents && !webContents.isDestroyed() && this.rendererReady)
  }

  private async requestDispatch(
    automation: Automation,
    run: AutomationRun,
    target: AutomationRunTargetResult
  ): Promise<AutomationRun> {
    if (!target.ok) {
      return this.runs.updateRun({
        runId: run.id,
        status: 'skipped_unavailable',
        workspaceId: automation.workspaceId,
        error: target.error
      })
    }
    if (!this.canDispatchToRenderer()) {
      if (this.headlessDispatcher) {
        return await runHeadlessAutomationDispatch({
          automation,
          run,
          target,
          dispatcher: withHeadlessAutomationLaunchProvenance(this.store, this.headlessDispatcher),
          runs: this.runs,
          runPrecheck: () => this.runPrecheck(automation.id, run.id),
          markDispatchResult: (result) => this.markDispatchResult(result),
          watchRun: (dispatched) => this.completionWatcher?.watch(dispatched),
          assertDispatchAllowed: () => {
            const current = this.resolveTarget(automation)
            if (!current.ok) {
              throw new Error(current.error)
            }
          }
        })
      }
      return this.runs.updateRun({
        runId: run.id,
        status: 'skipped_unavailable',
        workspaceId: automation.workspaceId,
        error: NO_DISPATCH_HOST
      })
    }
    const updated = this.runs.updateRun({
      runId: run.id,
      status: 'dispatching',
      workspaceId: automation.workspaceId,
      error: null
    })
    const projectBrief = await this.resolveProjectBrief?.(automation).catch(() => null)
    const payload = {
      ...createAutomationDispatchRequest(this.store, automation, updated),
      ...(projectBrief ? { projectBrief } : {})
    }
    this.rendererDispatches.sent(updated.id)
    this.webContents?.send('automations:dispatchRequested', payload)
    return updated
  }
}
