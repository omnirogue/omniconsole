import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ZodType } from 'zod'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { prepareLocalMetaReadPublication } from '../automations/local-meta-read-authority'
import { evaluateAdvertisingRoutine } from '../automations/typesafe-advertising-evaluation'
import {
  advertisingTestEnvelope,
  advertisingTestLocalObservation
} from '../automations/typesafe-advertising-fixtures'
import {
  OLDACS_ACCOUNT_ID,
  OLDACS_ROUTINE_ID
} from '../automations/typesafe-advertising-local-scope'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import type { Store } from '../persistence'
import { parseDecisionConfiguration } from './decision-configuration'
import type { DecisionRecords } from './decision-records'
import type { DecisionService } from './decision-service'
import {
  publishRoutineAdvertising,
  type RoutineDecisionEvaluationContext
} from './routine-decision-evaluation'
import { routineDecisionSourceRevision } from './routine-decision-records'
import { RoutineDecisionService } from './routine-decision-service'

vi.mock('../automations/local-meta-read-authority', () => ({
  assertLocalMetaReadAuthorized: vi.fn(),
  prepareLocalMetaReadPublication: vi.fn(),
  authorizeLocalMetaRead: vi.fn()
}))
vi.mock('../automations/typesafe-advertising-evaluation', () => ({
  evaluateAdvertisingRoutine: vi.fn()
}))
vi.mock('../backoffice/console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

function fixture(cached = false) {
  const envelope = advertisingTestEnvelope()
  envelope.routineId = OLDACS_ROUTINE_ID
  envelope.policy.accountId = OLDACS_ACCOUNT_ID
  envelope.decisions[0].evidence.target.accountId = OLDACS_ACCOUNT_ID
  envelope.evaluatedAt = Date.now()
  envelope.decisions[0].evidence.source = 'local.meta.graph'
  envelope.decisions[0].evidence.measuredAt = null
  envelope.decisions[0].evidence.observation = advertisingTestLocalObservation
  envelope.decisions[0].recommendationOnly = true
  const automation = {
    id: envelope.routineId,
    prompt: 'Native advertising report',
    executionTargetType: 'local',
    executionTargetId: 'local',
    structuredOutput: {
      provider: 'typesafe',
      contract: 'advertising.v1',
      advertising: envelope.policy
    }
  } as Automation
  const run = {
    id: envelope.runId,
    automationId: automation.id,
    status: 'completed',
    outputSnapshot: {
      provenance: 'assistant_message',
      format: 'plain_text',
      content: 'Confirmed report',
      capturedAt: envelope.evaluatedAt,
      truncated: false
    }
  } as AutomationRun
  const owner = vi.fn<Store['automationOwnerPrecondition']>(() => ({ selector: { kind: 'self' } }))
  const person = { principal: envelope.principal, isCurrent: vi.fn(() => true) }
  const store = {
    listAutomations: () => [automation],
    listAutomationRuns: () => [run],
    automationOwnerPrecondition: owner
  }
  const source = routineDecisionSourceRevision(automation, run)
  const saved = new Map<string, unknown>()
  const resultKey = `result:${automation.id}:${run.id}:advertising`
  if (cached) {
    saved.set(resultKey, { source, envelope })
  }
  const records = {
    read: vi.fn(async <T>(kind: string, key: string, schema: ZodType<T>) => {
      const parsed = schema.safeParse(saved.get(`${kind}:${key}`))
      return parsed.success ? parsed.data : null
    }),
    write: vi.fn(async <T>(kind: string, key: string, value: T, schema: ZodType<T>) => {
      saved.set(`${kind}:${key}`, schema.parse(value))
    })
  }
  const configured = parseDecisionConfiguration({
    version: 1,
    enabled: true,
    capabilities: { 'advertising.routine': { mode: 'live' } }
  })
  const configuration = vi.fn(async () => configured)
  const notify = vi.fn()
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: { ...person, baseUrl: 'https://example.invalid', bearer: 'fixture' }
  })
  vi.mocked(evaluateAdvertisingRoutine).mockResolvedValue(envelope)
  const service = new RoutineDecisionService({
    store: store as unknown as Store,
    service: {} as DecisionService,
    configuration,
    records: records as unknown as DecisionRecords,
    notify
  })
  return {
    envelope,
    automation,
    run,
    owner,
    person,
    records,
    configuration,
    configured,
    notify,
    service,
    saved,
    resultKey,
    get: () => service.advertising(automation.id, run.id)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prepareLocalMetaReadPublication)
    .mockReset()
    .mockResolvedValue(() => undefined)
})

const boundaries = [
  {
    cached: false,
    enabledRead: 2,
    writes: 0,
    notifications: 0,
    boundary: 'pre-write enabled read'
  },
  {
    cached: false,
    enabledRead: 3,
    writes: 1,
    notifications: 0,
    boundary: 'post-write enabled read'
  },
  {
    cached: false,
    enabledRead: 4,
    writes: 1,
    notifications: 1,
    boundary: 'public response enabled read'
  },
  {
    cached: true,
    enabledRead: 2,
    writes: 0,
    notifications: 0,
    boundary: 'cached return enabled read'
  },
  {
    cached: true,
    enabledRead: 3,
    writes: 0,
    notifications: 0,
    boundary: 'cached public response enabled read'
  }
]

describe('final local authorization at advertising publication boundaries', () => {
  it.each(boundaries)(
    'refuses revocation during $boundary',
    async ({ cached, enabledRead, writes, notifications }) => {
      const f = fixture(cached)
      let authorized = true
      const configured = await f.configuration()
      f.configuration.mockClear().mockImplementation(async () => {
        if (f.configuration.mock.calls.length === enabledRead) {
          authorized = false
        }
        return configured
      })
      vi.mocked(prepareLocalMetaReadPublication).mockImplementation(async () => () => {
        if (!authorized) {
          throw new Error('Local Meta read authority revoked')
        }
      })
      await expect(f.get()).rejects.toThrow('authority revoked')
      expect(f.records.write).toHaveBeenCalledTimes(writes)
      expect(f.notify).toHaveBeenCalledTimes(notifications)
    }
  )

  it.each(boundaries)(
    'honors the kill switch changed during private authorization before $boundary',
    async ({ cached, enabledRead, writes, notifications }) => {
      const f = fixture(cached)
      vi.mocked(prepareLocalMetaReadPublication).mockImplementation(async () => {
        if (vi.mocked(prepareLocalMetaReadPublication).mock.calls.length === enabledRead - 1) {
          f.configured.killSwitch = true
        }
        return () => undefined
      })
      await expect(f.get()).rejects.toThrow('disabled')
      expect(f.records.write).toHaveBeenCalledTimes(writes)
      expect(f.notify).toHaveBeenCalledTimes(notifications)
    }
  )

  it('does not notify or return after revocation during the durable write', async () => {
    const f = fixture()
    let authorized = true
    vi.mocked(prepareLocalMetaReadPublication).mockImplementation(async () => () => {
      if (!authorized) {
        throw new Error('Local Meta read authority revoked')
      }
    })
    f.records.write.mockImplementation(
      async <T>(kind: string, key: string, value: T, schema: ZodType<T>) => {
        f.saved.set(`${kind}:${key}`, schema.parse(value))
        authorized = false
      }
    )
    await expect(f.get()).rejects.toThrow('authority revoked')
    expect(f.records.write).toHaveBeenCalledOnce()
    expect(f.notify).not.toHaveBeenCalled()
    expect(f.saved.has(f.resultKey)).toBe(true)
    await expect(f.get()).rejects.toThrow('authority revoked')
    expect(evaluateAdvertisingRoutine).toHaveBeenCalledOnce()
  })

  it.each(['principal', 'source', 'owner'] as const)(
    'rechecks %s synchronously after the final private authority await',
    async (changed) => {
      const f = fixture()
      vi.mocked(prepareLocalMetaReadPublication).mockImplementation(async () => {
        if (changed === 'principal') {
          f.person.isCurrent.mockReturnValue(false)
        }
        if (changed === 'source') {
          f.automation.prompt = 'Changed instructions'
        }
        if (changed === 'owner') {
          f.owner.mockReturnValue({ selector: { kind: 'orphan' } })
        }
        return () => undefined
      })
      await expect(f.get()).rejects.toThrow(/changed|disabled/)
      expect(f.records.write).not.toHaveBeenCalled()
      expect(f.notify).not.toHaveBeenCalled()
    }
  )

  it('leaves submitted signed-action recovery independent of live mode and local read grants', async () => {
    const envelope = advertisingTestEnvelope()
    const enabled = vi.fn().mockResolvedValue(false)
    const context = {
      active: () => true,
      enabled,
      current: () => false
    } as unknown as RoutineDecisionEvaluationContext
    const publication = vi.fn(() => envelope)
    expect(
      await publishRoutineAdvertising(
        context,
        envelope.routineId,
        envelope.runId,
        { principal: envelope.principal, isCurrent: () => true },
        { envelope, source: null },
        publication
      )
    ).toBe(envelope)
    expect(enabled).not.toHaveBeenCalled()
    expect(prepareLocalMetaReadPublication).not.toHaveBeenCalled()
    expect(publication).toHaveBeenCalledOnce()
  })
})
