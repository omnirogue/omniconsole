import { hostname } from 'node:os'
import { join } from 'node:path'
import type { JevRequestControl, JevRequestInput } from '../../shared/jev-control'
import type { JevRubricEvaluationInput } from '../../shared/jev-rubrics'
import type { RubricLibraryEntry } from '../../shared/rubric-library'
import { evaluateJevRubric, recordJevRubricEvaluation } from './jev-rubric-evaluation'
import { evaluateJevRequest } from './jev-request-record'
import { persistJevRecord } from './jev-record-storage'
import { recipeCallFields, rubricCallFields } from './jev-call-rows'
import {
  installJevLedger,
  ledgerWriteWithin,
  uninstallJevLedger,
  type JevLedger
} from './jev-ledger'
import { appendJevOutcome, exportJevRecords, listJevRecords } from './jev-ledger-records'
import type { JevRecordsExportParams, JevRecordsListParams } from '../../shared/jev-ledger'
import { z } from 'zod'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { agentHookServer } from '../agent-hooks/server'
import {
  createDecisionConfigurationReader,
  decisionConfigurationSchema
} from './decision-configuration'
import { DecisionService } from './decision-service'
import { DecisionTelemetry } from './decision-telemetry'
import { DecisionRecords } from './decision-records'
import { resolveTypesafeCredential } from './decision-credential'
import { TypeSafeDecisionProvider } from './typesafe-provider'
import { RoutineDecisionService } from './routine-decision-service'
import {
  installOrchestrationShadowObserver,
  observeOrchestrationToolAction,
  orchestrationShadowMeasurementSnapshot
} from './orchestration-shadow'
import { writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { setStructuredDecisionAvailability } from './decision-availability'
import { assertDecisionLiveActionEnabled } from './decision-live-action-fence'
import { LayaShadow } from './laya-shadow'
import { installJevHostControl, type JevHostControl } from './jev-host-control'

const runtimes = new WeakMap<OrcaRuntimeService, StructuredDecisionRuntime>()

function runtimeIdOf(runtime: OrcaRuntimeService): string | null {
  try {
    return runtime.getRuntimeId()
  } catch {
    return null
  }
}

export class StructuredDecisionRuntime {
  readonly jev: JevHostControl
  readonly ledger: JevLedger
  readonly routines: RoutineDecisionService
  readonly service: DecisionService
  readonly laya: LayaShadow
  readonly configurationPath: string
  private readonly configuration: ReturnType<typeof createDecisionConfigurationReader>
  private readonly detachShadow: () => void
  private readonly detachTools: () => void
  private readonly records: DecisionRecords
  private readonly telemetryRows: unknown[] = []
  private telemetryPersistedAt = Number.NEGATIVE_INFINITY
  private readonly runtime: OrcaRuntimeService
  private disposed = false

  constructor(options: { userDataPath: string; store: Store; runtime: OrcaRuntimeService }) {
    this.runtime = options.runtime
    this.jev = installJevHostControl(options.userDataPath)
    this.configurationPath = join(options.userDataPath, 'structured-decisions.json')
    this.configuration = createDecisionConfigurationReader(this.configurationPath)
    this.records = new DecisionRecords(join(options.userDataPath, 'structured-decisions'))
    this.ledger = installJevLedger(
      join(options.userDataPath, 'structured-decisions', 'jev-ledger'),
      {
        host: hostname(),
        runtimeId: runtimeIdOf(options.runtime)
      }
    )
    const telemetry = new DecisionTelemetry({
      capacity: 256,
      append: async (event) => {
        this.telemetryRows.push(event)
        if (this.telemetryRows.length > 256) {
          this.telemetryRows.shift()
        }
        // Shadow bursts must not cause a durable file sync for every ordinary tool event.
        const now = performance.now()
        if (now - this.telemetryPersistedAt < 1000) {
          return
        }
        this.telemetryPersistedAt = now
        await this.records.write(
          'result',
          'telemetry',
          this.telemetryRows,
          z.array(z.unknown()).max(256)
        )
      }
    })
    const routineMode = (id: string) =>
      options.store.automationOwnerPrecondition(id)?.selector.kind === 'self' &&
      options.store.listAutomations().some((row) => row.id === id && row.structuredOutput)
        ? ('live' as const)
        : ('off' as const)
    this.laya = new LayaShadow(options.userDataPath, {
      configuration: this.configuration,
      routineMode
    })
    this.service = new DecisionService({
      provider: new TypeSafeDecisionProvider({ resolveApiKey: resolveTypesafeCredential }),
      configuration: this.configuration,
      telemetry,
      routineMode,
      onEvaluated: (request, result) => this.laya.observe(request, result)
    })
    this.routines = new RoutineDecisionService({
      store: options.store,
      service: this.service,
      configuration: this.configuration,
      records: this.records,
      assertActionEnabled: (routineId) =>
        assertDecisionLiveActionEnabled(this.configurationPath, routineId),
      notify: (id) => {
        const selector = options.store.automationChangeSelector(id)
        options.runtime.notifyAutomationsChanged({
          reason: 'run',
          ...(selector ? { selector } : {})
        })
      }
    })
    this.detachShadow = installOrchestrationShadowObserver((request, comparison) =>
      this.service.observeShadow(request, comparison)
    )
    this.detachTools = agentHookServer.subscribeEnrichedStatus((event) => {
      if (!event.restoredUnconfirmed) {
        observeOrchestrationToolAction(event)
      }
    })
  }

  async evaluateRubric(
    input: JevRubricEvaluationInput,
    entry: RubricLibraryEntry,
    options: { disabled: boolean; control?: JevRequestControl }
  ) {
    const record = await evaluateJevRubric(input, entry, {
      ...options,
      disabled: options.disabled || this.disposed
    })
    const ledger = await ledgerWriteWithin(this.ledger.appendCall(rubricCallFields(record)))
    return recordJevRubricEvaluation(this.records, record, ledger)
  }

  /** Every `jev.request` result, including off and unavailable ones, is kept as a private record. */
  async request(
    input: JevRequestInput,
    options: { disabled: boolean; control: JevRequestControl }
  ) {
    const { record, call } = await evaluateJevRequest(input, {
      ...options,
      disabled: options.disabled || this.disposed
    })
    const key = `jev-request:${record.request_id}`
    const row = recipeCallFields(
      {
        recordKey: key,
        requestId: record.request_id,
        observedAt: record.observed_at,
        caller: 'jev.request',
        status: record.result.status,
        recipeRef: record.recipe_ref
      },
      record.result,
      call
    )
    const ledger = await ledgerWriteWithin(this.ledger.appendCall(row))
    return persistJevRecord(this.records, key, record, ledger)
  }

  listRecords(params: JevRecordsListParams) {
    return listJevRecords(this.ledger, params)
  }

  exportRecords(params: JevRecordsExportParams) {
    return exportJevRecords(this.ledger, params)
  }

  /** Rubric and request records written before the ledger existed still accept labels. */
  recordOutcome(params: unknown) {
    return appendJevOutcome(this.ledger, params, async (key) =>
      /^jev-(?:rubric|request):/.test(key)
        ? (await this.records.read('result', key, z.unknown())) !== null
        : false
    )
  }

  async status() {
    const configuration = await this.configuration()
    return {
      available: true,
      configurationPath: this.configurationPath,
      configuration,
      credentialConfigured: Boolean(await resolveTypesafeCredential()),
      telemetry: this.service.telemetry.snapshot(),
      measurement: {
        service: this.service.telemetry.measurementSnapshot(),
        observer: orchestrationShadowMeasurementSnapshot()
      },
      layaShadow: await this.laya.status(),
      semantics: {
        orchestration: 'shadow_only',
        structuredPassCreatesReceipt: false,
        shadowAddsInferenceCost: true
      }
    }
  }

  async disable(): Promise<{ disabled: true }> {
    this.service.abortPending()
    this.laya.service.abortPending()
    const previous = await this.configuration()
    const { valid: _valid, ...configuration } = previous
    const data = decisionConfigurationSchema.parse({
      ...configuration,
      enabled: false,
      killSwitch: true
    })
    const temporary = `${this.configurationPath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.configurationPath)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    this.service.abortPending()
    this.laya.service.abortPending()
    return { disabled: true }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.jev.dispose()
    uninstallJevLedger(this.ledger)
    if (runtimes.get(this.runtime) === this) {
      runtimes.delete(this.runtime)
      setStructuredDecisionAvailability(this.runtime, false)
    }
    this.detachTools()
    this.detachShadow()
    this.routines.dispose()
    this.service.dispose()
    this.laya.service.dispose()
  }
}

export function installStructuredDecisionRuntime(
  runtime: OrcaRuntimeService,
  options: { userDataPath: string; store: Store }
): StructuredDecisionRuntime {
  const previous = runtimes.get(runtime)
  previous?.dispose()
  setStructuredDecisionAvailability(runtime, false)
  const service = new StructuredDecisionRuntime({ ...options, runtime })
  runtimes.set(runtime, service)
  setStructuredDecisionAvailability(runtime, true)
  return service
}

export function getStructuredDecisionRuntime(
  runtime: OrcaRuntimeService
): StructuredDecisionRuntime {
  const service = runtimes.get(runtime)
  if (!service) {
    throw new Error('Structured decision capability is not available on this runtime.')
  }
  return service
}
