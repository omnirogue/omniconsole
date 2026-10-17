import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ZodType } from 'zod'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type {
  AdvertisingActionBinding,
  AdvertisingActionStore
} from '../automations/typesafe-advertising-actions'
import {
  advertisingTestEnvelope,
  advertisingTestPreview,
  advertisingTestReceipt
} from '../automations/typesafe-advertising-fixtures'
import type { Store } from '../persistence'
import { parseDecisionConfiguration } from './decision-configuration'
import type { DecisionRecords } from './decision-records'
import type { DecisionService } from './decision-service'
import { RoutineDecisionService } from './routine-decision-service'

const mocks = vi.hoisted(() => ({
  advertising: vi.fn(),
  capture: vi.fn(),
  isCurrent: vi.fn(() => true),
  actionStores: [] as AdvertisingActionStore[]
}))
vi.mock('../automations/typesafe-advertising-evaluation', () => ({
  evaluateAdvertisingRoutine: mocks.advertising
}))
vi.mock('../automations/typesafe-advertising-actions', () => ({
  TypesafeAdvertisingActionService: class {
    constructor(store: AdvertisingActionStore) {
      mocks.actionStores.push(store)
    }
  }
}))
vi.mock('../backoffice/console-workflow-person', () => ({
  captureConsoleWorkflowPerson: mocks.capture,
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

function fixture() {
  const envelope = advertisingTestEnvelope()
  const decision = envelope.decisions[0]!
  const binding: AdvertisingActionBinding = {
    automationId: envelope.routineId,
    runId: envelope.runId,
    decisionId: decision.id,
    principal: envelope.principal,
    sourceRevision: envelope.sourceRevision,
    idempotencyKey: `tsa:${decision.id}`,
    preview: advertisingTestPreview(),
    submitted: true,
    receipt: null
  }
  const automation = {
    id: envelope.routineId,
    prompt: 'Original advertising source',
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
      content: 'Original captured report',
      capturedAt: envelope.evaluatedAt,
      truncated: false
    }
  } as AutomationRun
  const configuration = parseDecisionConfiguration({
    version: 1,
    enabled: true,
    capabilities: { 'advertising.routine': { mode: 'live' } }
  })
  const resultKey = `result:${envelope.routineId}:${envelope.runId}:advertising`
  const actionKey = `action:${decision.id}`
  const saved = { source: 'persisted-before-the-current-source', envelope }
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
  const evaluate = vi.fn()
  const notify = vi.fn()
  const store = {
    listAutomations: () => [automation],
    listAutomationRuns: () => [run],
    automationOwnerPrecondition: vi.fn<Store['automationOwnerPrecondition']>(() => ({
      selector: { kind: 'self' }
    }))
  }
  const service = new RoutineDecisionService({
    store: store as unknown as Store,
    service: { evaluate } as unknown as DecisionService,
    configuration: () => configuration,
    records: records as unknown as DecisionRecords,
    notify
  })
  return {
    service,
    store,
    actions: mocks.actionStores.at(-1)!,
    envelope,
    binding,
    automation,
    run,
    configuration,
    stored,
    resultKey,
    actionKey,
    saved,
    records,
    evaluate,
    notify
  }
}

function expectRetained(f: ReturnType<typeof fixture>) {
  expect(f.stored.get(f.resultKey)).toBe(f.saved)
  expect(f.stored.get(f.actionKey)).toBe(f.binding)
  expect(f.records.write).not.toHaveBeenCalled()
  expect(mocks.advertising).not.toHaveBeenCalled()
  expect(f.evaluate).not.toHaveBeenCalled()
  expect(f.notify).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.actionStores.length = 0
  mocks.isCurrent.mockReturnValue(true)
  mocks.capture.mockResolvedValue({
    ok: true,
    data: { principal: 'person-1', isCurrent: mocks.isCurrent }
  })
  mocks.advertising.mockRejectedValue(new Error('Recovery must not invoke the evaluator.'))
})

describe('retained advertising action recovery', () => {
  it.each(['evaluation', 'verification-only readback'] as const)(
    'refuses pending-action %s if ownership changes during its record read',
    async (operation) => {
      const f = fixture()
      f.automation.prompt = 'Changed source with an unresolved submitted action'
      f.run.outputSnapshot!.content = 'Changed report with an unresolved submitted action'
      f.configuration.enabled = false
      f.records.read.mockImplementationOnce(
        async <T>(kind: string, key: string, schema: ZodType<T>) => {
          const saved = schema.parse(f.stored.get(`${kind}:${key}`))
          await Promise.resolve()
          f.store.automationOwnerPrecondition.mockReturnValue({
            selector: { kind: 'ssh', targetId: 'remote-1', targetGeneration: 1 }
          })
          return saved
        }
      )

      if (operation === 'evaluation') {
        await expect(f.service.advertising(f.envelope.routineId, f.envelope.runId)).rejects.toThrow(
          /changed|disabled|execution host|owner/
        )
      } else {
        expect(
          await f.actions.loadEnvelope(f.envelope.routineId, f.envelope.runId, {
            verificationOnly: true
          })
        ).toBeNull()
      }

      expect(f.records.read).toHaveBeenCalled()
      expectRetained(f)
    }
  )

  it.each([
    { selector: { kind: 'ssh', targetId: 'remote-1', targetGeneration: 1 } },
    { selector: { kind: 'orphan' } },
    null
  ] satisfies ReturnType<Store['automationOwnerPrecondition']>[])(
    'refuses submitted-action readback after its authoritative owner leaves this host: %j',
    async (owner) => {
      const f = fixture()
      f.store.automationOwnerPrecondition.mockReturnValue(owner)
      f.automation.prompt = 'Moved routine source'
      f.run.outputSnapshot!.content = 'Moved report source'
      delete f.automation.structuredOutput
      f.configuration.enabled = false

      await expect(f.service.advertising(f.envelope.routineId, f.envelope.runId)).rejects.toThrow(
        /execution host|owning host|owner/
      )
      expect(
        await f.actions.loadEnvelope(f.envelope.routineId, f.envelope.runId, {
          verificationOnly: true
        })
      ).toBeNull()
      expect(await f.actions.loadPolicy(f.envelope.routineId)).toBeNull()
      expect(f.automation.executionTargetType).toBe('local')
      expectRetained(f)
    }
  )

  it.each(['global off', 'kill switch', 'routine off'] as const)(
    'preserves a submitted pending action for readback after %s',
    async (mode) => {
      const f = fixture()
      if (mode === 'global off') {
        f.configuration.enabled = false
      }
      if (mode === 'kill switch') {
        f.configuration.killSwitch = true
      }
      if (mode === 'routine off') {
        f.configuration.routines[f.envelope.routineId] = { mode: 'off' }
      }

      expect(await f.service.advertising(f.envelope.routineId, f.envelope.runId)).toEqual(
        f.envelope
      )
      expect(
        await f.actions.loadEnvelope(f.envelope.routineId, f.envelope.runId, {
          verificationOnly: true
        })
      ).toEqual(f.envelope)
      expect(await f.actions.loadPolicy(f.envelope.routineId)).toBeNull()
      expectRetained(f)
    }
  )

  it('retains the submitted envelope after the prompt, report and advertising policy change', async () => {
    const f = fixture()
    f.automation.prompt = 'Changed source instructions'
    f.run.outputSnapshot!.content = 'Changed captured report'
    if (f.automation.structuredOutput?.contract !== 'advertising.v1') {
      throw new Error('fixture')
    }
    f.automation.structuredOutput.advertising.accountId = 'act_654321'
    f.automation.structuredOutput.advertising.minConfidence = 0.99

    expect(await f.service.advertising(f.envelope.routineId, f.envelope.runId)).toEqual(f.envelope)
    expect(await f.actions.loadEnvelope(f.envelope.routineId, f.envelope.runId)).toBeNull()
    expect(
      await f.actions.loadEnvelope(f.envelope.routineId, f.envelope.runId, {
        verificationOnly: true
      })
    ).toEqual(f.envelope)
    expectRetained(f)
  })

  it('keeps recovery available when the routine option is removed and evaluation is globally off', async () => {
    const f = fixture()
    delete f.automation.structuredOutput
    f.configuration.enabled = false

    expect(await f.service.advertising(f.envelope.routineId, f.envelope.runId)).toEqual(f.envelope)
    expect(
      await f.actions.loadEnvelope(f.envelope.routineId, f.envelope.runId, {
        verificationOnly: true
      })
    ).toEqual(f.envelope)
    expectRetained(f)
  })

  it('refuses another signed principal without replacing the retained result or action', async () => {
    const f = fixture()
    mocks.capture.mockResolvedValue({
      ok: true,
      data: { principal: 'person-2', isCurrent: mocks.isCurrent }
    })

    await expect(f.service.advertising(f.envelope.routineId, f.envelope.runId)).rejects.toThrow(
      'person whose source evidence'
    )
    expect(
      await f.actions.loadEnvelope(f.envelope.routineId, f.envelope.runId, {
        verificationOnly: true
      })
    ).toBeNull()
    expectRetained(f)
  })

  it('refuses a principal change while recovering a stored action', async () => {
    const f = fixture()
    mocks.isCurrent.mockReturnValue(false)
    await expect(f.service.advertising(f.envelope.routineId, f.envelope.runId)).rejects.toThrow(
      'signed-in person changed'
    )
    expect(
      await f.actions.loadEnvelope(f.envelope.routineId, f.envelope.runId, {
        verificationOnly: true
      })
    ).toBeNull()
    expectRetained(f)
  })

  it.each([
    { submitted: false },
    { principal: 'person-2' },
    { runId: 'other-run' },
    { automationId: 'other-routine' },
    { decisionId: '3'.repeat(64) },
    { sourceRevision: '4'.repeat(64) }
  ])('does not acquire recovery authority from an unrelated action binding: %j', async (patch) => {
    const f = fixture()
    Object.assign(f.binding, patch)
    f.configuration.enabled = false
    await expect(f.service.advertising(f.envelope.routineId, f.envelope.runId)).rejects.toThrow(
      'disabled'
    )
    expectRetained(f)
  })

  it.each(['verified', 'not_issued'] as const)(
    'allows fresh evaluation after a submitted action is definitively %s',
    async (status) => {
      const f = fixture()
      f.binding.receipt = advertisingTestReceipt()
      f.binding.receipt.status = status
      if (status === 'not_issued') {
        f.binding.receipt.execution!.dispatched_at = null
        f.binding.receipt.execution!.outcome = { accepted: false, reference: null, result: {} }
        f.binding.receipt.execution!.verification = null
      }
      const fresh = advertisingTestEnvelope()
      fresh.evaluatedAt = Date.now()
      fresh.sourceRevision = '5'.repeat(64)
      fresh.decisions[0]!.id = '6'.repeat(64)
      mocks.advertising.mockResolvedValueOnce(fresh)

      expect(await f.service.advertising(f.envelope.routineId, f.envelope.runId)).toEqual(fresh)
      expect(mocks.advertising).toHaveBeenCalledTimes(1)
      expect(f.records.write).toHaveBeenCalledTimes(1)
      expect(f.records.write.mock.calls[0]?.slice(0, 2)).toEqual([
        'result',
        `${f.envelope.routineId}:${f.envelope.runId}:advertising`
      ])
      expect(f.stored.get(f.resultKey)).toEqual({ source: expect.any(String), envelope: fresh })
      expect(f.stored.get(f.actionKey)).toBe(f.binding)
      expect(f.notify).toHaveBeenCalledWith(f.envelope.routineId)
    }
  )
})
