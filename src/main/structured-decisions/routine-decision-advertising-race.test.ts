import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ZodType } from 'zod'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { AdvertisingActionBinding } from '../automations/typesafe-advertising-actions'
import type * as AdvertisingEvidenceModule from '../automations/typesafe-advertising-evidence'
import { fetchAdvertisingEvidence } from '../automations/typesafe-advertising-evidence'
import { evaluateAdvertisingRoutine } from '../automations/typesafe-advertising-evaluation'
import {
  advertisingTestEnvelope,
  advertisingTestEvidence,
  advertisingTestPreview,
  advertisingTestReceipt
} from '../automations/typesafe-advertising-fixtures'
import { consoleAdvertisingActionsClient } from '../backoffice/console-advertising-actions-client'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import type { Store } from '../persistence'
import { parseDecisionConfiguration } from './decision-configuration'
import type { DecisionRecords } from './decision-records'
import type { DecisionService } from './decision-service'
import { routineDecisionSourceRevision } from './routine-decision-records'
import { RoutineDecisionService } from './routine-decision-service'

vi.mock('../automations/typesafe-advertising-evaluation', () => ({
  evaluateAdvertisingRoutine: vi.fn()
}))
vi.mock('../automations/typesafe-advertising-evidence', async (original) => ({
  ...(await original<typeof AdvertisingEvidenceModule>()),
  fetchAdvertisingEvidence: vi.fn()
}))
vi.mock('../backoffice/console-advertising-actions-client', () => ({
  consoleAdvertisingActionsClient: { preview: vi.fn(), execute: vi.fn(), verify: vi.fn() }
}))
vi.mock('../backoffice/console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const drainAdmissions = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture() {
  const envelope = advertisingTestEnvelope()
  envelope.evaluatedAt = Date.now() - envelope.policy.maxEvidenceAgeSeconds * 1000 - 1
  const decision = envelope.decisions[0]!
  const preview = advertisingTestPreview()
  const selection = {
    automationId: envelope.routineId,
    runId: envelope.runId,
    decisionId: decision.id
  }
  const request = {
    ...selection,
    previewId: preview.id,
    expectedRevision: preview.revision,
    approved: true
  }
  const binding: AdvertisingActionBinding = {
    ...selection,
    principal: envelope.principal,
    sourceRevision: envelope.sourceRevision,
    idempotencyKey: `tsa:${decision.id}`,
    preview,
    submitted: false,
    receipt: null
  }
  const automation = {
    id: envelope.routineId,
    prompt: 'Advertising source',
    executionTargetType: 'local',
    executionTargetId: 'local',
    structuredOutput: {
      provider: 'typesafe',
      contract: 'advertising.v1',
      advertising: { ...envelope.policy }
    }
  } as Automation
  const run = {
    id: envelope.runId,
    automationId: automation.id,
    status: 'completed',
    outputSnapshot: {
      format: 'plain_text',
      provenance: 'assistant_message',
      content: 'Captured advertising report',
      capturedAt: Date.now(),
      truncated: false
    }
  } as AutomationRun
  const source = routineDecisionSourceRevision(automation, run)
  const resultKey = `result:${envelope.routineId}:${envelope.runId}:advertising`
  const actionKey = `action:${decision.id}`
  const saved = { source, envelope }
  const stored = new Map<string, unknown>([
    [resultKey, saved],
    [actionKey, binding]
  ])
  const records = {
    read: vi.fn(async <T>(kind: string, key: string, schema: ZodType<T>) => {
      const parsed = schema.safeParse(stored.get(`${kind}:${key}`))
      return parsed.success ? parsed.data : null
    }),
    write: vi.fn(async <T>(kind: string, key: string, value: T, schema: ZodType<T>) => {
      stored.set(`${kind}:${key}`, structuredClone(schema.parse(value)))
    })
  }
  const configuration = parseDecisionConfiguration({
    version: 1,
    enabled: true,
    capabilities: { 'advertising.routine': { mode: 'live' } }
  })
  const notify = vi.fn()
  const service = new RoutineDecisionService({
    store: {
      listAutomations: () => [automation],
      listAutomationRuns: () => [run],
      automationOwnerPrecondition: vi.fn<Store['automationOwnerPrecondition']>(() => ({
        selector: { kind: 'self' }
      }))
    } as unknown as Store,
    service: { evaluate: vi.fn() } as unknown as DecisionService,
    configuration: () => configuration,
    records: records as unknown as DecisionRecords,
    notify
  })
  const fresh = advertisingTestEnvelope()
  fresh.decisions[0]!.id = '3'.repeat(64)
  fresh.sourceRevision = '4'.repeat(64)
  return {
    service,
    envelope,
    selection,
    request,
    binding,
    fresh,
    saved,
    stored,
    resultKey,
    actionKey,
    records,
    notify,
    configuration
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date(advertisingTestEvidence.fetchedAt))
  vi.clearAllMocks()
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      principal: 'person-1',
      bearer: 'test',
      baseUrl: 'https://example.invalid',
      isCurrent: () => true
    }
  })
  vi.mocked(fetchAdvertisingEvidence).mockResolvedValue([structuredClone(advertisingTestEvidence)])
  vi.mocked(consoleAdvertisingActionsClient.preview).mockResolvedValue({
    ok: true,
    data: advertisingTestPreview()
  })
  vi.mocked(consoleAdvertisingActionsClient.execute).mockResolvedValue({
    ok: true,
    data: advertisingTestReceipt()
  })
  vi.mocked(consoleAdvertisingActionsClient.verify).mockResolvedValue({
    ok: true,
    data: advertisingTestReceipt()
  })
})
afterEach(() => vi.useRealTimers())

describe('advertising refresh and action admission share a run lock', () => {
  it.each(['preview', 'execute'] as const)(
    'waits for in-flight evaluation before admitting an old %s selection',
    async (operation) => {
      const f = fixture()
      const entered = deferred<void>()
      const evaluation = deferred<typeof f.fresh>()
      vi.mocked(evaluateAdvertisingRoutine).mockImplementation(async () => {
        entered.resolve(undefined)
        return evaluation.promise
      })
      const refresh = f.service.advertising(f.envelope.routineId, f.envelope.runId)
      await entered.promise
      let settled = false
      const admission =
        operation === 'preview'
          ? f.service.actions.preview(f.selection)
          : f.service.actions.execute(f.request)
      const outcome = admission.then(
        () => {
          settled = true
          return null
        },
        (error: unknown) => {
          settled = true
          return error
        }
      )
      await drainAdmissions()
      expect(settled).toBe(false)
      expect(fetchAdvertisingEvidence).not.toHaveBeenCalled()
      expect(consoleAdvertisingActionsClient.preview).not.toHaveBeenCalled()
      expect(consoleAdvertisingActionsClient.execute).not.toHaveBeenCalled()
      expect(f.records.write).not.toHaveBeenCalled()

      evaluation.resolve(f.fresh)
      await expect(refresh).resolves.toEqual(f.fresh)
      expect(await outcome).toEqual(
        expect.objectContaining({
          message: 'The selected advertising decision is unavailable for action admission.'
        })
      )
      expect(f.stored.get(f.resultKey)).toEqual({ source: f.saved.source, envelope: f.fresh })
      expect(f.stored.get(f.actionKey)).toBe(f.binding)
      expect(consoleAdvertisingActionsClient.execute).not.toHaveBeenCalled()
      expect(f.records.write).toHaveBeenCalledTimes(1)
    }
  )

  it('retains the original envelope after an unknown send and reconciles concurrent repeat clicks', async () => {
    const f = fixture()
    const entered = deferred<void>()
    const send = deferred<Awaited<ReturnType<typeof consoleAdvertisingActionsClient.execute>>>()
    vi.mocked(evaluateAdvertisingRoutine).mockResolvedValue(f.fresh)
    vi.mocked(consoleAdvertisingActionsClient.execute).mockImplementation(async () => {
      expect(f.stored.get(f.actionKey)).toMatchObject({ submitted: true, receipt: null })
      entered.resolve(undefined)
      return send.promise
    })
    const first = f.service.actions.execute(f.request)
    const unknownSend = expect(first).rejects.toThrow('unconfirmed')
    await entered.promise
    let refreshSettled = false
    const refresh = f.service.advertising(f.envelope.routineId, f.envelope.runId).then((value) => {
      refreshSettled = true
      return value
    })
    await drainAdmissions()
    expect(refreshSettled).toBe(false)
    expect(evaluateAdvertisingRoutine).not.toHaveBeenCalled()
    expect(f.stored.get(f.resultKey)).toBe(f.saved)

    send.resolve({ ok: false, error: { code: 'backoffice_unavailable', message: 'Timeout' } })
    await unknownSend
    await expect(refresh).resolves.toEqual(f.envelope)
    expect(f.stored.get(f.actionKey)).toMatchObject({ submitted: true, receipt: null })
    expect(f.stored.get(f.resultKey)).toBe(f.saved)
    expect(evaluateAdvertisingRoutine).not.toHaveBeenCalled()
    expect(f.notify).not.toHaveBeenCalled()

    const receipt = advertisingTestReceipt()
    receipt.status = 'unverified'
    receipt.execution!.verification = null
    vi.mocked(consoleAdvertisingActionsClient.verify).mockResolvedValue({ ok: true, data: receipt })
    await Promise.all([f.service.actions.execute(f.request), f.service.actions.execute(f.request)])
    expect(consoleAdvertisingActionsClient.execute).toHaveBeenCalledTimes(1)
    expect(consoleAdvertisingActionsClient.verify).toHaveBeenCalledTimes(2)
    expect(f.stored.get(f.actionKey)).toMatchObject({ submitted: true, receipt })
    f.configuration.enabled = false
    await expect(f.service.advertising(f.envelope.routineId, f.envelope.runId)).resolves.toEqual(
      f.envelope
    )
    await expect(f.service.actions.verify(f.selection)).resolves.toEqual({ receipt })
    expect(f.stored.get(f.resultKey)).toBe(f.saved)
    expect(evaluateAdvertisingRoutine).not.toHaveBeenCalled()
    expect(f.records.write.mock.calls.every(([kind]) => kind === 'action')).toBe(true)
    expect(consoleAdvertisingActionsClient.execute).toHaveBeenCalledTimes(1)
  })
})
