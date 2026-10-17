import { describe, expect, it } from 'vitest'
import { advertisingEvidence } from '../../shared/typesafe-advertising'
import {
  advertisingEvidenceRevision,
  assertAdvertisingEvidenceFresh
} from './typesafe-advertising-evidence'
import {
  advertisingTestEvidence,
  advertisingTestLocalObservation,
  advertisingTestPolicy
} from './typesafe-advertising-fixtures'

const local = {
  ...advertisingTestEvidence,
  source: 'local.meta.graph' as const,
  measuredAt: null,
  observation: advertisingTestLocalObservation
}
const now = Date.parse(local.fetchedAt)

describe('local collection freshness is not provider measurement finality', () => {
  it('requires an explicit provisional observation with unknown computation time', () => {
    expect(advertisingEvidence.parse(local)).toMatchObject({
      measuredAt: null,
      observation: {
        freshnessBasis: 'completed_native_read',
        collectedAt: local.fetchedAt,
        providerComputedAt: null,
        dayFinalized: false,
        attributionFinalized: false
      }
    })
    expect(() => assertAdvertisingEvidenceFresh(local, advertisingTestPolicy, now)).not.toThrow()
  })

  it.each([
    { measuredAt: local.fetchedAt },
    { observation: undefined },
    { observation: { ...local.observation, providerComputedAt: local.fetchedAt } },
    { observation: { ...local.observation, dayFinalized: true } },
    { observation: { ...local.observation, attributionFinalized: true } },
    { observation: { ...local.observation, freshnessBasis: 'http_date' } }
  ])('rejects invented or incomplete measurement metadata: %j', (patch) => {
    expect(advertisingEvidence.safeParse({ ...local, ...patch }).success).toBe(false)
  })

  it('does not weaken the coordinator native measurement timestamp requirement', () => {
    expect(
      advertisingEvidence.safeParse({ ...advertisingTestEvidence, measuredAt: null }).success
    ).toBe(false)
    expect(
      advertisingEvidence.safeParse({ ...advertisingTestEvidence, observation: local.observation })
        .success
    ).toBe(false)
  })

  it('does not refresh an old native collection merely by updating fetchedAt', () => {
    const stale = { ...local, fetchedAt: new Date(now + 301_000).toISOString() }
    expect(() =>
      assertAdvertisingEvidenceFresh(stale, advertisingTestPolicy, now + 301_000)
    ).toThrow('stale')
    expect(() =>
      assertAdvertisingEvidenceFresh(
        { ...local, observation: undefined },
        advertisingTestPolicy,
        now
      )
    ).toThrow('stale')
  })

  it('requires today in the actual account timezone independent of collection recency', () => {
    const priorWindow = { ...local, dateStart: '2026-09-19', dateStop: '2026-09-19' }
    expect(() => assertAdvertisingEvidenceFresh(priorWindow, advertisingTestPolicy, now)).toThrow(
      'today in the account timezone'
    )
  })

  it('binds source facts without presenting a later collection as changed business results', () => {
    const later = {
      ...local,
      fetchedAt: new Date(now + 1_000).toISOString(),
      observation: { ...local.observation, collectedAt: new Date(now + 1_000).toISOString() }
    }
    expect(advertisingEvidenceRevision(later)).toBe(advertisingEvidenceRevision(local))
    expect(
      advertisingEvidenceRevision({ ...local, metrics: { ...local.metrics, spend: 43 } })
    ).not.toBe(advertisingEvidenceRevision(local))
  })
})
