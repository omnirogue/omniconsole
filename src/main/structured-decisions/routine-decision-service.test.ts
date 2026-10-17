import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ZodType } from 'zod'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { AdvertisingDecisionEnvelope } from '../../shared/typesafe-advertising'
import type { RoutineStructuredResult } from '../../shared/routine-structured-result'
import type { Store } from '../persistence'
import type { AdvertisingActionStore } from '../automations/typesafe-advertising-actions'
import {
  parseDecisionConfiguration,
  type DecisionConfigurationSource
} from './decision-configuration'
import type { DecisionRecords } from './decision-records'
import type { DecisionService } from './decision-service'
import { RoutineDecisionService } from './routine-decision-service'

const mocks = vi.hoisted(() => ({
  classify: vi.fn(),
  advertising: vi.fn(),
  capture: vi.fn(),
  actionStores: [] as unknown[]
}))
vi.mock('../backoffice/console-workflow-person', () => ({
  captureConsoleWorkflowPerson: mocks.capture
}))
vi.mock('./routine-classification', () => ({ classifyRoutineOutput: mocks.classify }))
vi.mock('../automations/typesafe-advertising-evaluation', () => ({
  evaluateAdvertisingRoutine: mocks.advertising
}))
vi.mock('../automations/typesafe-advertising-actions', () => ({
  TypesafeAdvertisingActionService: class {
    constructor(store: unknown) {
      mocks.actionStores.push(store)
    }
  }
}))

function classificationResult(input: {
  routineId: string
  runId: string
  sourceRevision: string
}): RoutineStructuredResult {
  return {
    routineId: input.routineId,
    runId: input.runId,
    sourceRevision: input.sourceRevision,
    protocol: 'routine-classification.v1',
    evaluatedAt: Date.now(),
    status: 'ready',
    reason: null,
    verdict: 'PASS',
    severity: 'INFO',
    confidence: 0.9,
    provider: 'typesafe',
    model: 'fixture'
  }
}

function fixtures(contract: 'classification.v1' | 'advertising.v1' = 'classification.v1') {
  const automation = {
    id: 'routine-1',
    prompt: 'Read the trusted source',
    executionTargetType: 'local',
    executionTargetId: 'local',
    structuredOutput:
      contract === 'classification.v1'
        ? { provider: 'typesafe', contract }
        : {
            provider: 'typesafe',
            contract,
            advertising: { company: 'omnirogue', accountId: 'act_123456' }
          }
  } as Automation
  const run = {
    id: 'run-1',
    automationId: automation.id,
    status: 'completed',
    outputSnapshot: {
      format: 'plain_text',
      provenance: 'assistant_message',
      content: 'Host-observed report',
      capturedAt: Date.now(),
      truncated: false
    }
  } as AutomationRun
  let configuration = parseDecisionConfiguration({
    version: 1,
    enabled: true,
    capabilities: {
      'routine.structured': { mode: 'live' },
      'advertising.routine': { mode: 'live' }
    }
  })
  const stored = new Map<string, unknown>()
  const records = {
    read: vi.fn(async <T>(kind: string, key: string, schema: ZodType<T>) => {
      const parsed = schema.safeParse(stored.get(`${kind}:${key}`))
      return parsed.success ? parsed.data : null
    }),
    write: vi.fn(async <T>(kind: string, key: string, value: T, schema: ZodType<T>) => {
      stored.set(`${kind}:${key}`, JSON.parse(JSON.stringify(schema.parse(value))))
    })
  }
  const store = {
    listAutomations: vi.fn(() => [automation]),
    listAutomationRuns: vi.fn(() => [run]),
    automationOwnerPrecondition: vi.fn<Store['automationOwnerPrecondition']>(() => ({
      selector: { kind: 'self' }
    }))
  }
  const notify = vi.fn()
  const evaluate = vi.fn()
  const configurationSource = vi.fn<DecisionConfigurationSource>(() => configuration)
  const options = {
    store: store as unknown as Store,
    service: { evaluate } as unknown as DecisionService,
    configuration: configurationSource,
    records: records as unknown as DecisionRecords,
    notify
  }
  const service = new RoutineDecisionService(options)
  return {
    automation,
    run,
    store,
    service,
    options,
    records,
    stored,
    notify,
    evaluate,
    configurationSource,
    setConfiguration: (next: typeof configuration) => {
      configuration = next
    },
    configuration: () => configuration,
    actions: mocks.actionStores.at(-1) as AdvertisingActionStore
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.actionStores.length = 0
  mocks.capture.mockResolvedValue({
    ok: true,
    data: { principal: 'person-1', isCurrent: () => true }
  })
  mocks.classify.mockImplementation(async (input) => classificationResult(input))
  mocks.advertising.mockImplementation(
    async (input) =>
      ({
        protocol: 'typesafe-advertising.v1',
        routineId: input.routineId,
        runId: input.runId,
        evaluatedAt: Date.now(),
        principal: 'person-1',
        sourceRevision: 'a'.repeat(64),
        policy: input.policy,
        status: 'ready',
        reason: null,
        provider: 'typesafe',
        model: 'fixture',
        decisions: []
      }) satisfies AdvertisingDecisionEnvelope
  )
})
afterEach(() => vi.restoreAllMocks())

describe('RoutineDecisionService host authority', () => {
  const rejectedOwners: {
    kind: string
    owner: ReturnType<Store['automationOwnerPrecondition']>
  }[] = [
    {
      kind: 'ssh',
      owner: { selector: { kind: 'ssh', targetId: 'remote-1', targetGeneration: 1 } }
    },
    { kind: 'orphan', owner: { selector: { kind: 'orphan' } } },
    { kind: 'unknown', owner: null }
  ]

  it.each(rejectedOwners)(
    'refuses both contracts for a stored local row projected to $kind before inference',
    async ({ owner }) => {
      for (const contract of ['classification.v1', 'advertising.v1'] as const) {
        const fixture = fixtures(contract)
        fixture.store.automationOwnerPrecondition.mockReturnValue(owner)
        const work =
          contract === 'classification.v1'
            ? fixture.service.classification('routine-1', 'run-1')
            : fixture.service.advertising('routine-1', 'run-1')

        await expect(work).rejects.toThrow(/execution host|owning host|owner/)

        expect(fixture.automation.executionTargetType).toBe('local')
        expect(fixture.store.automationOwnerPrecondition).toHaveBeenCalledWith('routine-1')
        expect(fixture.records.read).not.toHaveBeenCalled()
        expect(fixture.records.write).not.toHaveBeenCalled()
        expect(fixture.notify).not.toHaveBeenCalled()
      }
      expect(mocks.classify).not.toHaveBeenCalled()
      expect(mocks.advertising).not.toHaveBeenCalled()
      expect(mocks.capture).not.toHaveBeenCalled()
    }
  )

  it.each(rejectedOwners)(
    'never schedules automatic evaluation for a local row projected to $kind',
    async ({ owner }) => {
      for (const contract of ['classification.v1', 'advertising.v1'] as const) {
        const fixture = fixtures(contract)
        fixture.store.automationOwnerPrecondition.mockReturnValue(owner)
        const classification = vi.spyOn(fixture.service, 'classification')
        const advertising = vi.spyOn(fixture.service, 'advertising')

        fixture.service.observeCompletedRuns()
        await Promise.resolve()

        expect(classification).not.toHaveBeenCalled()
        expect(advertising).not.toHaveBeenCalled()
        expect(fixture.store.listAutomationRuns).not.toHaveBeenCalled()
        expect(fixture.records.read).not.toHaveBeenCalled()
        expect(fixture.records.write).not.toHaveBeenCalled()
      }
      expect(mocks.classify).not.toHaveBeenCalled()
      expect(mocks.advertising).not.toHaveBeenCalled()
    }
  )

  it.each(['classification.v1', 'advertising.v1'] as const)(
    'rejects publication when the authoritative owner moves during %s inference',
    async (contract) => {
      const fixture = fixtures(contract)
      const evaluate = contract === 'classification.v1' ? mocks.classify : mocks.advertising
      const produceResult = evaluate.getMockImplementation()!
      const pending = deferred<RoutineStructuredResult | AdvertisingDecisionEnvelope>()
      evaluate.mockReturnValueOnce(pending.promise)
      const work =
        contract === 'classification.v1'
          ? fixture.service.classification('routine-1', 'run-1')
          : fixture.service.advertising('routine-1', 'run-1')
      await vi.waitFor(() => expect(evaluate).toHaveBeenCalledOnce())
      fixture.store.automationOwnerPrecondition.mockReturnValue({
        selector: { kind: 'ssh', targetId: 'remote-2', targetGeneration: 2 }
      })
      pending.resolve(await produceResult(evaluate.mock.calls[0][0]))

      await expect(work).rejects.toThrow(/changed|disabled|execution host|owning host|owner/)

      expect(fixture.automation.executionTargetType).toBe('local')
      expect(fixture.records.write).not.toHaveBeenCalled()
      expect(fixture.notify).not.toHaveBeenCalled()
    }
  )

  it('leaves ordinary routines untouched when the option is absent', async () => {
    const fixture = fixtures()
    delete fixture.automation.structuredOutput
    fixture.service.observeCompletedRuns()
    await Promise.resolve()
    expect(fixture.store.listAutomationRuns).not.toHaveBeenCalled()
    expect(mocks.classify).not.toHaveBeenCalled()
    expect(mocks.advertising).not.toHaveBeenCalled()
    expect(fixture.records.write).not.toHaveBeenCalled()
    await expect(fixture.service.classification('routine-1', 'run-1')).rejects.toThrow(
      'not enabled for this routine'
    )
  })

  it.each(['pending', 'dispatching', 'dispatched', 'dispatch_failed'] as const)(
    'requires completion before evaluating a %s run',
    async (status) => {
      const fixture = fixtures()
      fixture.run.status = status
      await expect(fixture.service.classification('routine-1', 'run-1')).rejects.toThrow(
        'completed routine run'
      )
      expect(mocks.classify).not.toHaveBeenCalled()
    }
  )

  it('requires a captured snapshot and the actual execution host', async () => {
    const fixture = fixtures()
    const snapshot = fixture.run.outputSnapshot
    fixture.run.outputSnapshot = null
    await expect(fixture.service.classification('routine-1', 'run-1')).rejects.toThrow(
      'captured output'
    )
    fixture.run.outputSnapshot = snapshot
    fixture.automation.executionTargetType = 'ssh'
    await expect(fixture.service.classification('routine-1', 'run-1')).rejects.toThrow(
      'execution host'
    )
    expect(mocks.classify).not.toHaveBeenCalled()
  })

  it('persists only host-produced classification and reuses it after service recreation', async () => {
    const fixture = fixtures()
    Object.assign(fixture.run, { structuredResult: { verdict: 'FAIL', provider: 'renderer' } })
    const result = await fixture.service.classification('routine-1', 'run-1')
    expect(result).toMatchObject({ verdict: 'PASS', provider: 'typesafe' })
    expect(mocks.classify).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Host-observed report',
        truncated: false,
        sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/)
      }),
      expect.any(Function)
    )
    expect(fixture.notify).toHaveBeenCalledWith('routine-1')
    const restarted = new RoutineDecisionService(fixture.options)
    expect(await restarted.classification('routine-1', 'run-1')).toEqual(result)
    expect(mocks.classify).toHaveBeenCalledTimes(1)
    expect(JSON.stringify([...fixture.stored.values()])).not.toContain('renderer')
  })

  it('deduplicates pending classification and refuses a changed report before persisting', async () => {
    const fixture = fixtures()
    const pending = deferred<RoutineStructuredResult>()
    mocks.classify.mockReturnValue(pending.promise)
    const first = fixture.service.classification('routine-1', 'run-1')
    const second = fixture.service.classification('routine-1', 'run-1')
    expect(second).toBe(first)
    await vi.waitFor(() => expect(mocks.classify).toHaveBeenCalledTimes(1))
    fixture.run.outputSnapshot!.content = 'Changed report'
    pending.resolve(classificationResult(mocks.classify.mock.calls[0][0]))
    await expect(first).rejects.toThrow('routine changed')
    expect(fixture.records.write).not.toHaveBeenCalled()
    expect(fixture.notify).not.toHaveBeenCalled()
  })

  it('refuses results if global mode is disabled during inference', async () => {
    const fixture = fixtures()
    const pending = deferred<RoutineStructuredResult>()
    mocks.classify.mockReturnValue(pending.promise)
    const work = fixture.service.classification('routine-1', 'run-1')
    await vi.waitFor(() => expect(mocks.classify).toHaveBeenCalled())
    fixture.setConfiguration({ ...fixture.configuration(), killSwitch: true })
    pending.resolve(classificationResult(mocks.classify.mock.calls[0][0]))
    await expect(work).rejects.toThrow('disabled during evaluation')
    expect(fixture.records.write).not.toHaveBeenCalled()
  })

  it.each(['off', 'shadow'] as const)(
    'refuses cached live classification when its routine switches to %s',
    async (mode) => {
      const fixture = fixtures()
      await fixture.service.classification('routine-1', 'run-1')
      fixture.setConfiguration({ ...fixture.configuration(), routines: { 'routine-1': { mode } } })
      await expect(fixture.service.classification('routine-1', 'run-1')).rejects.toThrow('disabled')
      expect(mocks.classify).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['source', 'configuration'] as const)(
    'rejects cached classification when %s changes during the awaited record read',
    async (changed) => {
      const fixture = fixtures()
      await fixture.service.classification('routine-1', 'run-1')
      fixture.records.write.mockClear()
      fixture.notify.mockClear()
      fixture.records.read.mockImplementationOnce(
        async <T>(kind: string, key: string, schema: ZodType<T>) => {
          const saved = schema.parse(fixture.stored.get(`${kind}:${key}`))
          await Promise.resolve()
          if (changed === 'source') {
            fixture.run.outputSnapshot!.content = 'Report changed while cached result was loading.'
          } else {
            fixture.setConfiguration({ ...fixture.configuration(), enabled: false })
          }
          return saved
        }
      )

      await expect(fixture.service.classification('routine-1', 'run-1')).rejects.toThrow(
        /changed|disabled/
      )

      expect(mocks.classify).toHaveBeenCalledTimes(1)
      expect(fixture.records.write).not.toHaveBeenCalled()
      expect(fixture.notify).not.toHaveBeenCalled()
    }
  )

  it.each(['source', 'configuration'] as const)(
    'rejects classification when %s changes during the awaited record write',
    async (changed) => {
      const fixture = fixtures()
      fixture.records.write.mockImplementationOnce(
        async <T>(kind: string, key: string, value: T, schema: ZodType<T>) => {
          fixture.stored.set(`${kind}:${key}`, schema.parse(value))
          await Promise.resolve()
          if (changed === 'source') {
            fixture.run.outputSnapshot!.content = 'Report changed while result was being stored.'
          } else {
            fixture.setConfiguration({ ...fixture.configuration(), enabled: false })
          }
        }
      )

      await expect(fixture.service.classification('routine-1', 'run-1')).rejects.toThrow(
        /changed|disabled/
      )

      expect(fixture.records.write).toHaveBeenCalledOnce()
      expect(fixture.notify).not.toHaveBeenCalled()
    }
  )

  it('retries a persisted blocked classification after the provider recovers', async () => {
    const fixture = fixtures()
    mocks.classify.mockImplementationOnce(async (input) => ({
      ...classificationResult(input),
      status: 'blocked',
      reason: 'Structured evaluation unavailable: no_api_key.',
      verdict: null,
      severity: null,
      confidence: null,
      provider: null,
      model: null
    }))
    expect((await fixture.service.classification('routine-1', 'run-1')).status).toBe('blocked')
    const restarted = new RoutineDecisionService(fixture.options)
    expect((await restarted.classification('routine-1', 'run-1')).status).toBe('ready')
    expect(mocks.classify).toHaveBeenCalledTimes(2)
  })

  it('retries disabled observations after a bounded cooldown and stops after success', async () => {
    const fixture = fixtures()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    fixture.setConfiguration({ ...fixture.configuration(), enabled: false })
    const classification = vi.spyOn(fixture.service, 'classification')
    fixture.service.observeCompletedRuns()
    await vi.waitFor(() => expect(classification).toHaveBeenCalledTimes(1))
    await classification.mock.results[0].value.catch(() => undefined)
    fixture.setConfiguration({ ...fixture.configuration(), enabled: true })
    fixture.service.observeCompletedRuns()
    await Promise.resolve()
    expect(classification).toHaveBeenCalledTimes(1)
    now += 60_001
    fixture.service.observeCompletedRuns()
    await vi.waitFor(() => expect(fixture.notify).toHaveBeenCalledTimes(1))
    await classification.mock.results[1].value
    now += 60_001
    fixture.service.observeCompletedRuns()
    await Promise.resolve()
    expect(classification).toHaveBeenCalledTimes(2)
    expect(mocks.classify).toHaveBeenCalledTimes(1)
  })
})

describe('RoutineDecisionService advertising source fencing', () => {
  it('rejects advertising when the person changes during the post-evaluation configuration read', async () => {
    const fixture = fixtures('advertising.v1')
    let personCurrent = true
    mocks.capture.mockResolvedValue({
      ok: true,
      data: { principal: 'person-1', isCurrent: () => personCurrent }
    })
    const configurationRead = deferred<ReturnType<typeof fixture.configuration>>()
    let awaitingConfiguration = false
    fixture.configurationSource.mockImplementation(() => {
      if (mocks.advertising.mock.calls.length > 0) {
        awaitingConfiguration = true
        return configurationRead.promise
      }
      return fixture.configuration()
    })

    const work = fixture.service.advertising('routine-1', 'run-1')
    await vi.waitFor(() => expect(awaitingConfiguration).toBe(true))
    personCurrent = false
    configurationRead.resolve(fixture.configuration())

    await expect(work).rejects.toThrow(/changed|disabled/)
    expect(fixture.records.write).not.toHaveBeenCalled()
    expect(fixture.notify).not.toHaveBeenCalled()
  })

  it('rejects advertising when the person changes during the awaited record write', async () => {
    const fixture = fixtures('advertising.v1')
    let personCurrent = true
    mocks.capture.mockResolvedValue({
      ok: true,
      data: { principal: 'person-1', isCurrent: () => personCurrent }
    })
    fixture.records.write.mockImplementationOnce(
      async <T>(kind: string, key: string, value: T, schema: ZodType<T>) => {
        fixture.stored.set(`${kind}:${key}`, schema.parse(value))
        await Promise.resolve()
        personCurrent = false
      }
    )

    await expect(fixture.service.advertising('routine-1', 'run-1')).rejects.toThrow(
      /changed|disabled/
    )

    expect(fixture.records.write).toHaveBeenCalledOnce()
    expect(fixture.notify).not.toHaveBeenCalled()
  })

  it('captures and rechecks each caller joining a pending advertising evaluation', async () => {
    const fixture = fixtures('advertising.v1')
    let secondPersonCurrent = true
    mocks.capture
      .mockResolvedValueOnce({
        ok: true,
        data: { principal: 'person-1', isCurrent: () => true }
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { principal: 'person-1', isCurrent: () => secondPersonCurrent }
      })
    const pending = deferred<AdvertisingDecisionEnvelope>()
    const produceEnvelope = mocks.advertising.getMockImplementation()!
    mocks.advertising.mockReturnValueOnce(pending.promise)

    const first = fixture.service.advertising('routine-1', 'run-1')
    await vi.waitFor(() => expect(mocks.advertising).toHaveBeenCalledOnce())
    const second = fixture.service.advertising('routine-1', 'run-1')
    const secondRejected = expect(second).rejects.toThrow(/changed|disabled/)
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(2))
    secondPersonCurrent = false
    pending.resolve(await produceEnvelope(mocks.advertising.mock.calls[0][0]))

    await expect(first).resolves.toMatchObject({ status: 'ready', principal: 'person-1' })
    await secondRejected
    expect(mocks.advertising).toHaveBeenCalledOnce()
  })

  it('ignores a renderer-supplied envelope and persists a host-evaluated envelope only', async () => {
    const fixture = fixtures('advertising.v1')
    Object.assign(fixture.run, {
      advertisingDecision: { principal: 'renderer', decisions: [{ kind: 'PAUSE' }] }
    })
    const envelope = await fixture.service.advertising('routine-1', 'run-1')
    expect(envelope.principal).toBe('person-1')
    expect(mocks.advertising).toHaveBeenCalledWith(
      {
        routineId: 'routine-1',
        runId: 'run-1',
        content: 'Host-observed report',
        scope: {
          routineId: 'routine-1',
          runId: 'run-1',
          isCurrent: expect.any(Function)
        },
        policy: {
          company: 'omnirogue',
          accountId: 'act_123456',
          allowedObjectTypes: ['adset', 'ad'],
          minConfidence: 0.8,
          maxEvidenceAgeSeconds: 300
        }
      },
      expect.any(Function)
    )
    expect(await fixture.actions.loadEnvelope('routine-1', 'run-1')).toEqual(envelope)
    expect(JSON.stringify([...fixture.stored.values()])).not.toContain('renderer')
    const scope = mocks.advertising.mock.calls[0][0].scope
    expect(scope?.isCurrent()).toBe(true)
    fixture.automation.prompt = 'Changed routine instructions'
    expect(scope?.isCurrent()).toBe(false)
  })

  it('invalidates cached action authority when the routine policy changes', async () => {
    const fixture = fixtures('advertising.v1')
    await fixture.service.advertising('routine-1', 'run-1')
    if (fixture.automation.structuredOutput?.contract !== 'advertising.v1') {
      throw new Error('fixture')
    }
    fixture.automation.structuredOutput.advertising.accountId = 'act_654321'
    expect(await fixture.actions.loadEnvelope('routine-1', 'run-1')).toBeNull()
  })

  it('refuses advertising after a policy change during evaluation', async () => {
    const fixture = fixtures('advertising.v1')
    const pending = deferred<AdvertisingDecisionEnvelope>()
    mocks.advertising.mockReturnValue(pending.promise)
    const work = fixture.service.advertising('routine-1', 'run-1')
    await vi.waitFor(() => expect(mocks.advertising).toHaveBeenCalled())
    if (fixture.automation.structuredOutput?.contract !== 'advertising.v1') {
      throw new Error('fixture')
    }
    fixture.automation.structuredOutput.advertising.minConfidence = 0.95
    const input = mocks.advertising.mock.calls[0][0]
    pending.resolve({
      protocol: 'typesafe-advertising.v1',
      routineId: 'routine-1',
      runId: 'run-1',
      evaluatedAt: Date.now(),
      principal: 'person-1',
      sourceRevision: 'b'.repeat(64),
      policy: input.policy,
      status: 'ready',
      reason: null,
      provider: 'typesafe',
      model: 'fixture',
      decisions: []
    })
    await expect(work).rejects.toThrow('routine changed')
    expect(fixture.records.write).not.toHaveBeenCalled()
  })

  it.each(['off', 'shadow'] as const)(
    'removes action policy authority in %s mode',
    async (mode) => {
      const fixture = fixtures('advertising.v1')
      fixture.setConfiguration({ ...fixture.configuration(), routines: { 'routine-1': { mode } } })
      expect(await fixture.actions.loadPolicy('routine-1')).toBeNull()
    }
  )

  it('refuses truncated advertising reports without invoking the provider', async () => {
    const fixture = fixtures('advertising.v1')
    fixture.run.outputSnapshot!.truncated = true
    await expect(fixture.service.advertising('routine-1', 'run-1')).rejects.toThrow(
      'complete advertising report'
    )
    expect(mocks.advertising).not.toHaveBeenCalled()
  })
})
