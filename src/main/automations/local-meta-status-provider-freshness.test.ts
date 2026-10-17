import { beforeEach, describe, expect, it, vi } from 'vitest'
import { META_NOW } from './local-meta-fixtures'
import {
  localStatusFixture,
  mockLocalStatusAuthority,
  submittedLocalBinding
} from './local-meta-status-fixtures'
import {
  executeLocalStatus,
  prepareLocalStatusPreview,
  verifyLocalStatus
} from './local-meta-status-provider'
import * as localStatusTransport from './local-meta-status-transport'
import { advertisingDigest, advertisingEvidenceRevision } from './typesafe-advertising-evidence'

vi.mock('./local-meta-action-authority', () => ({ authorizeLocalMetaAction: vi.fn() }))

type Fixture = Awaited<ReturnType<typeof localStatusFixture>>
const BEFORE_MIDNIGHT = Date.parse('2026-09-21T04:59:59.999Z')

function setEvidenceTimes(value: Fixture, collectedAt: number, fetchedAt: number) {
  const { evidence } = value.context.decision
  if (!evidence.observation) {
    throw new Error('The fixture must have a local collection observation.')
  }
  evidence.observation.collectedAt = new Date(collectedAt).toISOString()
  evidence.fetchedAt = new Date(fetchedAt).toISOString()
  value.context.decision.evidenceRevision = advertisingEvidenceRevision(evidence)
  value.context.envelope.sourceRevision = advertisingDigest(evidence)
}

function advanceAtFinalWriterFence(value: Fixture, time: number) {
  const original = localStatusTransport.createLocalMetaStatusWriter
  const reached = vi.fn(async () => value.setTime(time))
  vi.spyOn(localStatusTransport, 'createLocalMetaStatusWriter').mockImplementationOnce(
    (identity, options) =>
      original(
        {
          ...identity,
          assertCurrent: async () => {
            await identity.assertCurrent()
            await reached()
          }
        },
        options
      )
  )
  return reached
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  mockLocalStatusAuthority()
})

describe('local status evidence freshness at the write boundary', () => {
  it.each(['collectedAt', 'fetchedAt', 'both'] as const)(
    'refuses %s aged beyond 300 seconds during reads while the preview is still valid',
    async (agedTimestamp) => {
      const value = await localStatusFixture('ad')
      const startedAt = META_NOW + 240_000
      setEvidenceTimes(
        value,
        agedTimestamp === 'fetchedAt' ? startedAt : META_NOW,
        agedTimestamp === 'collectedAt' ? startedAt : META_NOW
      )
      value.setTime(startedAt)
      const preview = await prepareLocalStatusPreview(value.context, value.options)
      expect(Date.parse(preview.created_at)).toBe(startedAt)
      expect(value.context.envelope.policy.maxEvidenceAgeSeconds).toBe(300)
      value.fetch.mockClear()
      let elapsed = 0
      value.behavior.onGet = () => {
        elapsed += 8750
        value.setTime(startedAt + elapsed)
      }

      await expect(
        executeLocalStatus(value.context, submittedLocalBinding(preview), value.options)
      ).rejects.toThrow()

      expect(elapsed).toBe(70_000)
      expect(value.fetch.mock.calls).toHaveLength(8)
      expect(startedAt + elapsed - META_NOW).toBe(310_000)
      expect(Date.parse(preview.expires_at)).toBeGreaterThan(value.options.now())
      expect(value.posts()).toHaveLength(0)
    }
  )

  it('refuses account midnight crossed inside the final awaited authority check', async () => {
    const value = await localStatusFixture()
    setEvidenceTimes(value, BEFORE_MIDNIGHT - 1000, BEFORE_MIDNIGHT - 1000)
    value.setTime(BEFORE_MIDNIGHT)
    expect(value.context.decision.evidence.timezone).toBe('America/Panama')
    expect(value.context.decision.evidence.dateStart).toBe('2026-09-20')
    const preview = await prepareLocalStatusPreview(value.context, value.options)
    const reached = advanceAtFinalWriterFence(value, BEFORE_MIDNIGHT + 2)

    await expect(
      executeLocalStatus(value.context, submittedLocalBinding(preview), value.options)
    ).rejects.toThrow()

    expect(reached).toHaveBeenCalledOnce()
    expect(value.options.now() - Date.parse(preview.created_at)).toBe(2)
    expect(Date.parse(preview.expires_at)).toBeGreaterThan(value.options.now())
    expect(value.posts()).toHaveLength(0)
  })

  it.each(['old evidence', 'account midnight'] as const)(
    'allows GET-only recovery after %s without refreshing the decision or resending',
    async (condition) => {
      const value = await localStatusFixture()
      const startedAt = condition === 'account midnight' ? BEFORE_MIDNIGHT : META_NOW
      setEvidenceTimes(value, startedAt, startedAt)
      value.setTime(startedAt)
      const preview = await prepareLocalStatusPreview(value.context, value.options)
      const binding = submittedLocalBinding(preview)
      value.setTime(startedAt + (condition === 'account midnight' ? 2 : 310_000))
      value.fixture.adset.status = 'PAUSED'
      value.fixture.adset.effective_status = 'PAUSED'
      value.fetch.mockClear()

      const receipt = await verifyLocalStatus(value.context, binding, value.options)

      expect(receipt).toMatchObject({
        status: 'verified',
        execution: {
          requested_at: preview.created_at,
          dispatched_at: null,
          outcome: null,
          verification: { claim: 'target_state_observed', causality: 'unproven' }
        }
      })
      expect(value.fetch.mock.calls).toHaveLength(6)
      expect(value.fetch.mock.calls.every(([, request]) => request?.method === 'GET')).toBe(true)
      expect(value.posts()).toHaveLength(0)
    }
  )
})
