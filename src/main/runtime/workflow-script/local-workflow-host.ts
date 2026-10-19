import {
  retryLocalWorkflowPlacement,
  assertWorkflowRetryAllowed
} from './local-workflow-retry-placement'
import {
  createOrchestrationCaller,
  type OrchestrationCaller
} from '../build-review/build-review-rpc-call'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import type {
  LocalWorkflowChangedEvent,
  LocalWorkflowControlRequest,
  LocalWorkflowReadCallRequest,
  LocalWorkflowReadCallResult,
  LocalWorkflowSetupRequest,
  LocalWorkflowSetupResult,
  LocalWorkflowShowRequest,
  LocalWorkflowStartRequest,
  LocalWorkflowStartResult
} from '../../../shared/local-workflow-rpc'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import {
  WorkflowExecutionService,
  type WorkflowExecutionOutcome
} from './workflow-execution-service'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { projectLocalWorkflow, readLocalWorkflowExecution } from './local-workflow-projection'
import {
  projectLocalWorkflowOutput,
  reconcileCompletedLocalWorkflowOutputs
} from './local-workflow-output'
import { admitLocalWorkflow } from './local-workflow-host-admission'
import { localWorkflowSetupResult } from './local-workflow-host-setup'
import { LocalWorkflowHostLive, localWorkflowRestingStatus } from './local-workflow-host-live'
import { readLocalWorkflowCallLog } from './local-workflow-call-log'
import type { LocalWorkflowReceiptCache } from './local-workflow-call-projection'
import { WorkingWorkflowExecutionService } from './working-workflow-execution-service'
import { LocalWorkflowCapabilities } from './local-workflow-host-capability'
import { readWorkingWorkflowCallLog, withWorkingWorkflowLogs } from './local-workflow-working-logs'
import {
  projectWorkingLocalWorkflowOrRecovery,
  workingLocalWorkflowDurableKey
} from './local-workflow-working-projection'
import type {
  LocalWorkflowHostOptions,
  LocalWorkflowWorkspace
} from './local-workflow-host-options'

export type { LocalWorkflowWorkspace } from './local-workflow-host-options'

/**
 * One desktop host, one shared capacity pool, the durable frozen-analysis execution service and,
 * when the orchestration runtime is present, the writable working-agent execution service.
 */
export class LocalWorkflowHost {
  private readonly store: WorkflowCheckpointStore
  private readonly service: WorkflowExecutionService
  private readonly live: LocalWorkflowHostLive
  private readonly working?: WorkingWorkflowExecutionService
  private readonly workingRead?: OrchestrationCaller
  private readonly outcomes = new Map<string, WorkflowExecutionOutcome>()
  private readonly capabilities: LocalWorkflowCapabilities
  private readonly receipts: LocalWorkflowReceiptCache = new Map()
  private admission: Promise<unknown> = Promise.resolve()
  private readonly recovery = new Map<string, Promise<void>>()

  constructor(private readonly options: LocalWorkflowHostOptions) {
    this.store = new WorkflowCheckpointStore(options.db)
    this.capabilities = new LocalWorkflowCapabilities(options.db)
    this.live = new LocalWorkflowHostLive({
      db: options.db,
      project: (id) => this.project(id),
      view: (id) => this.view(id),
      notify: options.notify,
      // Working calls advance in their own tables, not the execution row's sequence.
      ...(options.working
        ? { durableExtra: (id: string) => workingLocalWorkflowDurableKey(options.db, id) }
        : {})
    })
    const registry = this.live.registry
    this.service = new WorkflowExecutionService({
      store: this.store,
      slots: options.slots,
      reservation: 1,
      // One automatic retry inside a run; the user's Retry spends the last persisted attempt.
      attemptsPerRun: 2,
      progress: (id, event) => registry.progress(id, event),
      live: registry,
      launch: (snapshot, id, fence) =>
        options.launch(snapshot as LocalWorkflowHostSnapshot, id, fence, registry.observer(id)),
      attestNativeResult: options.attestNativeResult,
      ...(options.seatCapacity ? { seatCapacity: options.seatCapacity } : {}),
      budgetAuthority: options.budgetAuthority
    })
    if (options.working) {
      this.workingRead = createOrchestrationCaller(options.working.runtime)
      this.working = new WorkingWorkflowExecutionService({
        db: options.working.db,
        runtime: options.working.runtime,
        store: this.store,
        slots: options.slots,
        progress: (id, event) => registry.progress(id, event)
      })
    }
    void reconcileCompletedLocalWorkflowOutputs(options.db, this.store, (id) => this.project(id))
  }

  async setup(request: LocalWorkflowSetupRequest): Promise<LocalWorkflowSetupResult> {
    const workspace = await this.options.resolve(request)
    const [catalog, scopeOptions] = await Promise.all([
      (this.options.refreshCapacity?.() ?? Promise.resolve()).then(() => this.options.catalog()),
      this.options.listScope(workspace)
    ])
    return localWorkflowSetupResult({
      db: this.options.db,
      conversationKey: this.conversationKey(workspace, request.conversationId),
      preset: request.preset,
      catalog,
      scopeOptions,
      scopeLabel: workspace.label,
      slotLimit: this.options.slots.limit
    })
  }

  start(request: LocalWorkflowStartRequest): Promise<LocalWorkflowStartResult> {
    const work = this.admission.then(async () => {
      const result = await admitLocalWorkflow(request, {
        options: this.options,
        store: this.store,
        service: this.service
      })
      if ('executionId' in result) {
        this.observe(result.executionId)
        this.live.registry.touch(result.executionId)
      }
      return result
    })
    this.admission = work.catch(() => {})
    return work
  }

  async show(request: LocalWorkflowShowRequest): Promise<LocalWorkflowView> {
    await this.authorize(request)
    await this.restore(request.executionId)
    return this.withWorkingLogs(await this.view(request.executionId))
  }

  /** Emits the view now and after every durable or live change until the returned stop runs. */
  async watch(
    request: LocalWorkflowShowRequest,
    emit: (view: LocalWorkflowView) => void
  ): Promise<() => void> {
    await this.authorize(request)
    await this.restore(request.executionId)
    return this.live.watch(request.executionId, emit)
  }

  /** The tab strip's status for a run nobody has opened since the app started; no recovery. */
  async status(request: LocalWorkflowShowRequest): Promise<LocalWorkflowChangedEvent> {
    await this.authorize(request)
    const id = request.executionId
    const active = this.isWorking(id)
      ? (this.working?.isActive(id) ?? false)
      : this.service.isActive(id)
    const attended = active || this.outcomes.has(id) || this.recovery.has(id)
    return localWorkflowRestingStatus(this.project(id), request.conversationId, !attended)
  }

  async readCall(request: LocalWorkflowReadCallRequest): Promise<LocalWorkflowReadCallResult> {
    await this.authorize(request)
    const { executionId, callId } = request
    if (this.workingRead && this.isWorking(executionId)) {
      return readWorkingWorkflowCallLog(this.options.db, this.workingRead, executionId, callId)
    }
    return readLocalWorkflowCallLog(this.options.db, this.store, executionId, callId)
  }

  async control(request: LocalWorkflowControlRequest): Promise<LocalWorkflowView> {
    await this.authorize(request)
    await this.restore(request.executionId)
    const row = readLocalWorkflowExecution(this.options.db, request.executionId)
    const working = this.isWorking(row.id)
    if (row.fence !== request.fence) {
      throw new Error('Workflow ownership changed; refresh before controlling it.')
    }
    if (request.action === 'retry') {
      assertWorkflowRetryAllowed(working, this.service.isActive(row.id))
      const fence = await this.store.claimOwner(row.id, row.fence, this.options.owner)
      await retryLocalWorkflowPlacement(this.store, this.options, row.id, fence)
      this.live.registry.restart(row.id)
      this.service.resume(row.id, fence)
      this.observe(row.id)
    } else if (request.action === 'resume') {
      const service = working ? this.working! : this.service
      if (!service.isActive(row.id)) {
        this.live.registry.restart(row.id)
      }
      service.resume(row.id, row.fence)
      this.observe(row.id)
    } else {
      if (working) {
        this.working!.control(row.id, row.fence, request.action)
      } else {
        this.service.control(row.id, row.fence, request.action)
      }
      this.outcomes.delete(row.id)
    }
    this.live.registry.touch(row.id)
    return this.withWorkingLogs(await this.view(row.id))
  }

  private async authorize(request: LocalWorkflowShowRequest): Promise<void> {
    const workspace = await this.options.resolve(request)
    const row = readLocalWorkflowExecution(this.options.db, request.executionId)
    if (row.conversation_id !== this.conversationKey(workspace, request.conversationId)) {
      throw new Error('Workflow belongs to another conversation.')
    }
  }

  private conversationKey(workspace: LocalWorkflowWorkspace, conversationId: string): string {
    return JSON.stringify([workspace.id, conversationId])
  }

  private observe(id: string): void {
    this.outcomes.delete(id)
    void this.serviceFor(id)
      .wait(id)
      .then(async (outcome) => {
        this.outcomes.set(id, outcome)
        this.live.registry.finish(id)
        await projectLocalWorkflowOutput(this.project(id), this.store)
        // Only a run this app saw settle: reopening an old one never counts as settling it.
        this.options.onSettled?.(id, outcome.state, () => this.view(id))
      })
      .catch((error) => {
        this.outcomes.set(id, { state: 'recovery_required', error: String(error) })
        this.live.registry.finish(id)
      })
  }

  private async restore(id: string): Promise<void> {
    const service = this.serviceFor(id)
    if (service.isActive(id) || this.outcomes.has(id)) {
      return
    }
    const pending = this.recovery.get(id)
    if (pending) {
      return pending
    }
    const work = (async () => {
      const row = readLocalWorkflowExecution(this.options.db, id)
      if (row.state === 'completed') {
        this.outcomes.set(id, await service.recoverCompleted(id, row.fence))
        return
      }
      if (['cancelled', 'failed', 'recovery_failed'].includes(row.state)) {
        return
      }
      try {
        if (service instanceof WorkingWorkflowExecutionService) {
          // The working program runs again from its journal. It is live once claimed, so watch,
          // show and control return now, and observe finishes it like any other run.
          await service.resumeInterrupted(id, row.fence, this.options.owner)
          this.observe(id)
          return
        }
        this.outcomes.set(id, await service.recoverInterrupted(id, row.fence, this.options.owner))
      } catch (error) {
        this.outcomes.set(id, {
          state: 'recovery_required',
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })().finally(() => {
      this.recovery.delete(id)
      this.live.registry.touch(id)
    })
    this.recovery.set(id, work)
    return work
  }

  private view(executionId: string): Promise<LocalWorkflowView> {
    return projectLocalWorkflowOutput(this.project(executionId), this.store)
  }

  /** The run's view from its records and live state, without recovering it (`omni workflow status`). */
  project(executionId: string): LocalWorkflowView {
    if (this.isWorking(executionId)) {
      return projectWorkingLocalWorkflowOrRecovery({
        db: this.options.db,
        store: this.store,
        executionId,
        active: this.working?.isActive(executionId) ?? false,
        error: this.outcomes.get(executionId)?.error,
        live: this.live.registry.read(executionId)
      })
    }
    return projectLocalWorkflow({
      db: this.options.db,
      store: this.store,
      executionId,
      outcome: this.outcomes.get(executionId),
      active: this.service.isActive(executionId),
      live: this.live.registry.read(executionId),
      receipts: this.receipts
    })
  }

  /** A working run is never recovered by the frozen service, which would launch other agents. */
  private serviceFor(id: string): WorkflowExecutionService | WorkingWorkflowExecutionService {
    if (!this.isWorking(id)) {
      return this.service
    }
    if (!this.working) {
      throw new Error('Working-agent runtime is unavailable on this host.')
    }
    return this.working
  }

  private isWorking(id: string): boolean {
    return this.capabilities.isWorking(id)
  }

  private async withWorkingLogs(view: LocalWorkflowView): Promise<LocalWorkflowView> {
    if (!this.workingRead || !this.isWorking(view.executionId)) {
      return view
    }
    return withWorkingWorkflowLogs(this.options.db, this.workingRead, view)
  }
}
