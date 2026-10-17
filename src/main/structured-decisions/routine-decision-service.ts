import type { Store } from '../persistence'
import { automationStructuredOutputSchema } from '../../shared/automation-structured-output'
import type { AdvertisingDecisionEnvelope } from '../../shared/typesafe-advertising'
import type { RoutineStructuredResult } from '../../shared/routine-structured-result'
import { TypesafeAdvertisingActionService } from '../automations/typesafe-advertising-actions'
import type { DecisionConfigurationSource } from './decision-configuration'
import type { DecisionService } from './decision-service'
import type { DecisionRecords } from './decision-records'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import { isLiveRoutineDecisionEnabled } from './routine-decision-mode'
import { withRoutineDecisionRunLock, withAdvertisingObjectLock } from './routine-decision-lock'
import { captureRoutineActionScope } from './routine-action-scope'
import {
  readAdvertisingObjectAction,
  writeAdvertisingActionBinding
} from './routine-action-records'
import {
  evaluateRoutineAdvertising,
  evaluateRoutineClassification,
  publishRoutineAdvertising,
  type RoutineDecisionEvaluationContext
} from './routine-decision-evaluation'
import {
  actionBindingSchema,
  readRoutineDecisionSource,
  readAdvertisingDecision,
  routineDecisionSourceRevision as sourceRevision
} from './routine-decision-records'

const OBSERVATION_RETRY_MS = 60_000

export class RoutineDecisionService {
  readonly actions: TypesafeAdvertisingActionService
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly observed = new Map<
    string,
    { source: string; retryAt: number; complete: boolean }
  >()
  private disposed = false

  constructor(
    private readonly options: {
      store: Store
      service: DecisionService
      configuration: DecisionConfigurationSource
      records: DecisionRecords
      notify: (automationId: string) => void
      assertActionEnabled?: (routineId: string) => void
    }
  ) {
    this.actions = new TypesafeAdvertisingActionService({
      loadEnvelope: (routineId, runId, readOptions) =>
        this.readAdvertising(routineId, runId, readOptions?.verificationOnly),
      loadPolicy: async (routineId) => {
        if (!(await this.enabled(routineId, 'advertising.routine'))) {
          return null
        }
        const automation = this.options.store.listAutomations().find((row) => row.id === routineId)
        const settings = automationStructuredOutputSchema.safeParse(automation?.structuredOutput)
        if (!settings.success || settings.data.contract !== 'advertising.v1') {
          return null
        }
        return settings.data.advertising
      },
      loadAction: (decisionId) =>
        this.options.records.read('action', decisionId, actionBindingSchema, { failClosed: true }),
      saveAction: (binding) => writeAdvertisingActionBinding(this.options.records, binding),
      loadObjectAction: (accountId, nativeId) =>
        readAdvertisingObjectAction(this.options.records, accountId, nativeId),
      withObjectLock: (accountId, nativeId, work) =>
        withAdvertisingObjectLock(this.options.store, accountId, nativeId, work),
      captureLocalScope: (routineId, runId, verificationOnly) =>
        captureRoutineActionScope(
          { ...this.options, active: () => !this.disposed },
          routineId,
          runId,
          verificationOnly
        ),
      withRunLock: (routineId, runId, work) =>
        withRoutineDecisionRunLock(this.options.store, routineId, runId, work)
    })
  }

  private async enabled(routineId: string, capability: string): Promise<boolean> {
    if (this.disposed) {
      return false
    }
    const config = await this.options.configuration()
    return (
      !this.disposed &&
      this.options.store.automationOwnerPrecondition(routineId)?.selector.kind === 'self' &&
      isLiveRoutineDecisionEnabled(config, routineId, capability)
    )
  }

  private source(routineId: string, runId: string) {
    return readRoutineDecisionSource(this.options.store, routineId, runId)
  }

  private current(routineId: string, runId: string, source: string): boolean {
    try {
      return !this.disposed && this.source(routineId, runId).source === source
    } catch {
      return false
    }
  }

  private async readAdvertising(
    routineId: string,
    runId: string,
    verificationOnly = false
  ): Promise<AdvertisingDecisionEnvelope | null> {
    if (
      this.disposed ||
      this.options.store.automationOwnerPrecondition(routineId)?.selector.kind !== 'self'
    ) {
      return null
    }
    const envelope = await readAdvertisingDecision(
      this.options.records,
      routineId,
      runId,
      verificationOnly ? undefined : () => this.source(routineId, runId).source
    )
    return this.disposed ||
      this.options.store.automationOwnerPrecondition(routineId)?.selector.kind !== 'self'
      ? null
      : envelope
  }

  private evaluationContext(routineId: string): RoutineDecisionEvaluationContext {
    return {
      ...this.options,
      active: () =>
        !this.disposed &&
        this.options.store.automationOwnerPrecondition(routineId)?.selector.kind === 'self',
      enabled: (routineId, capability) => this.enabled(routineId, capability),
      current: (routineId, runId, source) => this.current(routineId, runId, source)
    }
  }

  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key)
    if (existing) {
      return existing as Promise<T>
    }
    if (this.pending.size >= 4) {
      return Promise.reject(new Error('Structured evaluation is busy; try again shortly.'))
    }
    const promise = work()
    this.pending.set(key, promise)
    void promise
      .finally(() => {
        if (this.pending.get(key) === promise) {
          this.pending.delete(key)
        }
      })
      .catch(() => undefined)
    return promise
  }

  async advertising(routineId: string, runId: string): Promise<AdvertisingDecisionEnvelope> {
    if (this.disposed) {
      throw new Error('Structured decisions are unavailable.')
    }
    if (this.options.store.automationOwnerPrecondition(routineId)?.selector.kind !== 'self') {
      throw new Error('Structured decisions must run on the routine execution host.')
    }
    const captured = await captureConsoleWorkflowPerson()
    if (!captured.ok) {
      throw new Error('Sign in to read this company’s advertising decisions.')
    }
    const person = captured.data
    const key = JSON.stringify([
      routineId,
      runId,
      'advertising',
      person.principal,
      person.profileKey
    ])
    const result = await this.once(key, () =>
      withRoutineDecisionRunLock(this.options.store, routineId, runId, () =>
        evaluateRoutineAdvertising(this.evaluationContext(routineId), routineId, runId, person)
      )
    )
    // Coalescing never borrows the first caller's session fence for later callers.
    return publishRoutineAdvertising(
      this.evaluationContext(routineId),
      routineId,
      runId,
      person,
      result,
      () => result.envelope
    )
  }

  classification(routineId: string, runId: string): Promise<RoutineStructuredResult> {
    return this.once(`${routineId}:${runId}:classification`, () =>
      evaluateRoutineClassification(this.evaluationContext(routineId), routineId, runId)
    )
  }

  observeCompletedRuns(): void {
    if (this.disposed) {
      return
    }
    const configured = new Map(
      this.options.store
        .listAutomations()
        .filter(
          (row) =>
            row.structuredOutput &&
            this.options.store.automationOwnerPrecondition(row.id)?.selector.kind === 'self'
        )
        .map((row) => [row.id, row])
    )
    if (!configured.size) {
      return
    }
    for (const run of this.options.store.listAutomationRuns().slice(0, 100)) {
      const automation = configured.get(run.automationId)
      if (
        !automation ||
        run.status !== 'completed' ||
        !run.outputSnapshot ||
        Date.now() - run.outputSnapshot.capturedAt > 15 * 60_000
      ) {
        continue
      }
      const source = sourceRevision(automation, run)
      const prior = this.observed.get(run.id)
      if (
        (prior?.source === source && (prior.complete || prior.retryAt > Date.now())) ||
        this.pending.size >= 4
      ) {
        continue
      }
      const attempt = { source, retryAt: Date.now() + OBSERVATION_RETRY_MS, complete: false }
      this.observed.set(run.id, attempt)
      if (this.observed.size > 256) {
        this.observed.delete(this.observed.keys().next().value!)
      }
      queueMicrotask(() => {
        if (this.disposed) {
          return
        }
        const work =
          automation.structuredOutput?.contract === 'advertising.v1'
            ? this.advertising(automation.id, run.id)
            : this.classification(automation.id, run.id)
        void work
          .then((result) => {
            if (this.observed.get(run.id) === attempt) {
              attempt.complete = result.status === 'ready'
              attempt.retryAt = Date.now() + OBSERVATION_RETRY_MS
            }
          })
          .catch(() => {
            if (this.observed.get(run.id) === attempt) {
              attempt.retryAt = Date.now() + OBSERVATION_RETRY_MS
            }
          })
      })
    }
  }

  dispose(): void {
    this.disposed = true
  }
}
