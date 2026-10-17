import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ZodType } from 'zod'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import {
  advertisingRoutinePolicy,
  type AdvertisingDecisionEnvelope
} from '../../shared/typesafe-advertising'
import type { Store } from '../persistence'
import { parseDecisionConfiguration } from './decision-configuration'
import type { DecisionRecords } from './decision-records'
import type { DecisionService } from './decision-service'
import { routineDecisionSourceRevision } from './routine-decision-records'
import { RoutineDecisionService } from './routine-decision-service'

const mocks = vi.hoisted(() => ({ advertising: vi.fn(), capture: vi.fn() }))
vi.mock('../backoffice/console-workflow-person', () => ({
  captureConsoleWorkflowPerson: mocks.capture,
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
vi.mock('../automations/typesafe-advertising-evaluation', () => ({
  evaluateAdvertisingRoutine: mocks.advertising
}))
vi.mock('../automations/typesafe-advertising-actions', () => ({
  TypesafeAdvertisingActionService: class {}
}))

const services: RoutineDecisionService[] = []
const policy = advertisingRoutinePolicy.parse({ company: 'omnirogue', accountId: 'act_123456' })
type Session = { principal: string; profileKey: string }
let session: Session

function capturedPerson(captured: Session, isCurrent = () => session === captured) {
  return {
    ok: true as const,
    data: {
      ...captured,
      baseUrl: 'https://fixture.invalid',
      bearer: 'fixture-only-credential',
      isCurrent
    }
  }
}

function envelope(principal: string, model = 'fixture-model'): AdvertisingDecisionEnvelope {
  return {
    protocol: 'typesafe-advertising.v1',
    routineId: 'routine-1',
    runId: 'run-1',
    evaluatedAt: Date.now(),
    principal,
    sourceRevision: 'a'.repeat(64),
    policy,
    status: 'ready',
    reason: null,
    provider: 'typesafe',
    model,
    decisions: []
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function outcome<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason })
  )
}

function fixture() {
  const automation = {
    id: 'routine-1',
    prompt: 'Read the trusted advertising evidence',
    executionTargetType: 'local',
    executionTargetId: 'local',
    structuredOutput: { provider: 'typesafe', contract: 'advertising.v1', advertising: policy }
  } as Automation
  const run = {
    id: 'run-1',
    automationId: automation.id,
    status: 'completed',
    outputSnapshot: {
      format: 'plain_text',
      provenance: 'assistant_message',
      content: 'Host-captured advertising report',
      capturedAt: Date.now(),
      truncated: false
    }
  } as AutomationRun
  const configuration = parseDecisionConfiguration({
    version: 1,
    enabled: true,
    capabilities: { 'advertising.routine': { mode: 'live' } }
  })
  const stored = new Map<string, unknown>()
  let beforeRead = async (): Promise<void> => {}
  let beforeWrite = async (): Promise<void> => {}
  const records = {
    read: vi.fn(async <T>(kind: string, key: string, schema: ZodType<T>) => {
      await beforeRead()
      const parsed = schema.safeParse(stored.get(`${kind}:${key}`))
      return parsed.success ? parsed.data : null
    }),
    write: vi.fn(async <T>(kind: string, key: string, value: T, schema: ZodType<T>) => {
      await beforeWrite()
      stored.set(`${kind}:${key}`, structuredClone(schema.parse(value)))
    })
  }
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
  services.push(service)
  return {
    service,
    records,
    stored,
    notify,
    source: routineDecisionSourceRevision(automation, run),
    waitBeforeRead: (barrier: () => Promise<void>) => {
      beforeRead = barrier
    },
    waitBeforeWrite: (barrier: () => Promise<void>) => {
      beforeWrite = barrier
    }
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  session = { principal: 'person-a', profileKey: 'profile-a' }
  mocks.capture.mockImplementation(async () => capturedPerson(session))
  mocks.advertising.mockImplementation(async () => envelope(session.principal))
})
afterEach(() => {
  services.splice(0).forEach((service) => service.dispose())
  vi.restoreAllMocks()
})

describe('advertising caller identity across pending work', () => {
  it.each([
    ['another principal', 'person-b', 'profile-b'],
    ['another profile for the same principal', 'person-a', 'profile-b']
  ])('does not share a pending result with %s', async (_label, principal, profileKey) => {
    const f = fixture()
    const firstEvaluation = deferred<AdvertisingDecisionEnvelope>()
    const secondEvaluation = deferred<AdvertisingDecisionEnvelope>()
    mocks.advertising
      .mockReturnValueOnce(firstEvaluation.promise)
      .mockReturnValueOnce(secondEvaluation.promise)
    const first = outcome(f.service.advertising('routine-1', 'run-1'))
    await vi.waitFor(() => expect(mocks.advertising).toHaveBeenCalledTimes(1))

    session = { principal, profileKey }
    const second = outcome(f.service.advertising('routine-1', 'run-1'))
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(2))
    firstEvaluation.resolve(envelope('person-a', 'old-session'))
    expect(await first).toMatchObject({ status: 'rejected', reason: expect.any(Error) })
    await vi.waitFor(() => expect(mocks.advertising).toHaveBeenCalledTimes(2))
    expect(f.records.write).not.toHaveBeenCalled()
    expect(f.notify).not.toHaveBeenCalled()

    const expected = envelope(principal, 'current-session')
    secondEvaluation.resolve(expected)
    expect(await second).toEqual({ status: 'fulfilled', value: expected })
    expect(f.records.write).toHaveBeenCalledTimes(1)
    expect(f.notify).toHaveBeenCalledExactlyOnceWith('routine-1')
    expect(f.stored.get('result:routine-1:run-1:advertising')).toMatchObject({ envelope: expected })
  })

  it('refuses a cached envelope if the same principal changes sessions during its read', async () => {
    const f = fixture()
    const reading = deferred<void>()
    const releaseRead = deferred<void>()
    f.stored.set('result:routine-1:run-1:advertising', {
      source: f.source,
      envelope: envelope('person-a', 'old-session')
    })
    f.waitBeforeRead(() => {
      reading.resolve()
      return releaseRead.promise
    })
    const result = outcome(f.service.advertising('routine-1', 'run-1'))
    await reading.promise
    session = { ...session }
    releaseRead.resolve()

    expect(await result).toMatchObject({ status: 'rejected', reason: expect.any(Error) })
    expect(mocks.advertising).not.toHaveBeenCalled()
    expect(f.records.write).not.toHaveBeenCalled()
    expect(f.notify).not.toHaveBeenCalled()
  })

  it('checks each coalesced caller session before delivering a shared result', async () => {
    const f = fixture()
    const pending = deferred<AdvertisingDecisionEnvelope>()
    let secondCurrent = true
    mocks.capture
      .mockResolvedValueOnce(capturedPerson(session))
      .mockResolvedValueOnce(capturedPerson(session, () => secondCurrent))
    mocks.advertising.mockReturnValue(pending.promise)
    const first = outcome(f.service.advertising('routine-1', 'run-1'))
    await vi.waitFor(() => expect(mocks.advertising).toHaveBeenCalledTimes(1))
    const second = outcome(f.service.advertising('routine-1', 'run-1'))
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(2))
    secondCurrent = false
    const expected = envelope('person-a')
    pending.resolve(expected)

    expect(await first).toEqual({ status: 'fulfilled', value: expected })
    expect(await second).toMatchObject({ status: 'rejected', reason: expect.any(Error) })
    expect(mocks.advertising).toHaveBeenCalledTimes(1)
  })

  it('rejects and emits no notification after identity changes during result persistence', async () => {
    const f = fixture()
    const writing = deferred<void>()
    const releaseWrite = deferred<void>()
    f.waitBeforeWrite(() => {
      writing.resolve()
      return releaseWrite.promise
    })
    const result = outcome(f.service.advertising('routine-1', 'run-1'))
    await writing.promise
    expect(f.records.write).toHaveBeenCalledTimes(1)
    session = { principal: 'person-b', profileKey: 'profile-b' }
    releaseWrite.resolve()

    expect(await result).toMatchObject({ status: 'rejected', reason: expect.any(Error) })
    expect(f.notify).not.toHaveBeenCalled()
  })
})
