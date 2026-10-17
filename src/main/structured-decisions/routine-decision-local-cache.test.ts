import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RecordsModule from './routine-decision-records'
import { prepareLocalMetaReadPublication } from '../automations/local-meta-read-authority'
import {
  advertisingTestEnvelope,
  advertisingTestLocalObservation
} from '../automations/typesafe-advertising-fixtures'
import { evaluateAdvertisingRoutine } from '../automations/typesafe-advertising-evaluation'
import { readRoutineDecisionSource } from './routine-decision-records'
import {
  evaluateRoutineAdvertising,
  type RoutineDecisionEvaluationContext
} from './routine-decision-evaluation'

vi.mock('../automations/local-meta-read-authority', () => ({
  assertLocalMetaReadAuthorized: vi.fn(),
  prepareLocalMetaReadPublication: vi.fn(),
  authorizeLocalMetaRead: vi.fn()
}))
vi.mock('../automations/typesafe-advertising-evaluation', () => ({
  evaluateAdvertisingRoutine: vi.fn()
}))
vi.mock('./routine-decision-records', async (original) => ({
  ...(await original<typeof RecordsModule>()),
  readRoutineDecisionSource: vi.fn(),
  hasUnresolvedAdvertisingAction: vi.fn().mockResolvedValue(false)
}))

function fixture(local = true) {
  const envelope = advertisingTestEnvelope()
  envelope.evaluatedAt = Date.now()
  if (local) {
    envelope.decisions[0].evidence.source = 'local.meta.graph'
    envelope.decisions[0].evidence.measuredAt = null
    envelope.decisions[0].evidence.observation = advertisingTestLocalObservation
    envelope.decisions[0].recommendationOnly = true
  }
  const input = {
    source: 'current-source',
    settings: { provider: 'typesafe', contract: 'advertising.v1', advertising: envelope.policy }
  } as ReturnType<typeof readRoutineDecisionSource>
  vi.mocked(readRoutineDecisionSource).mockReturnValue(input)
  const context = {
    store: {},
    service: {},
    records: {
      read: vi.fn().mockResolvedValue({ source: input.source, envelope }),
      write: vi.fn()
    },
    notify: vi.fn(),
    active: () => true,
    enabled: vi.fn().mockResolvedValue(true),
    current: vi.fn(() => true)
  }
  const evaluate = () =>
    evaluateRoutineAdvertising(
      context as unknown as RoutineDecisionEvaluationContext,
      envelope.routineId,
      envelope.runId,
      { principal: envelope.principal, isCurrent: () => true }
    )
  return { envelope, input, context, evaluate }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prepareLocalMetaReadPublication)
    .mockReset()
    .mockResolvedValue(() => undefined)
})

describe('local advertising cached result authority', () => {
  it('revalidates the reviewed signed person before returning cached local evidence', async () => {
    const f = fixture()
    expect((await f.evaluate()).envelope).toEqual(f.envelope)
    expect(prepareLocalMetaReadPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        routineId: f.envelope.routineId,
        runId: f.envelope.runId
      }),
      f.envelope.policy
    )
    expect(evaluateAdvertisingRoutine).not.toHaveBeenCalled()
    expect(f.context.records.write).not.toHaveBeenCalled()
  })

  it('refuses cached local evidence after the private authorization is revoked', async () => {
    const f = fixture()
    vi.mocked(prepareLocalMetaReadPublication).mockRejectedValue(
      new Error('Local Meta reporting is not authorized')
    )
    await expect(f.evaluate()).rejects.toThrow('not authorized')
    expect(f.context.records.write).not.toHaveBeenCalled()
    expect(f.context.notify).not.toHaveBeenCalled()
  })

  it('refuses the cache if owner or source changes during signed self verification', async () => {
    const f = fixture()
    vi.mocked(prepareLocalMetaReadPublication).mockImplementation(async () => {
      f.context.current.mockReturnValue(false)
      return () => undefined
    })
    await expect(f.evaluate()).rejects.toThrow('changed')
    expect(f.context.records.write).not.toHaveBeenCalled()
  })

  it('does not add local credential authority to existing coordinator results', async () => {
    const f = fixture(false)
    expect((await f.evaluate()).envelope).toEqual(f.envelope)
    expect(prepareLocalMetaReadPublication).not.toHaveBeenCalled()
    expect(evaluateAdvertisingRoutine).not.toHaveBeenCalled()
  })
})
