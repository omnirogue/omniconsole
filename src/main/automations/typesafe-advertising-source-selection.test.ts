import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authorizeLocalMetaRead } from './local-meta-read-authority'
import { fetchCoordinatorAdvertisingEvidence } from './typesafe-advertising-coordinator'
import { fetchAdvertisingEvidence } from './typesafe-advertising-evidence'
import { fetchLocalMetaEvidence } from './typesafe-advertising-local-meta-evidence'
import { OLDACS_ACCOUNT_ID, OLDACS_ROUTINE_ID } from './typesafe-advertising-local-scope'
import {
  advertisingTestEvidence,
  advertisingTestLocalObservation,
  advertisingTestPolicy
} from './typesafe-advertising-fixtures'

vi.mock('./local-meta-read-authority', () => ({ authorizeLocalMetaRead: vi.fn() }))
vi.mock('./typesafe-advertising-coordinator', () => ({
  fetchCoordinatorAdvertisingEvidence: vi.fn()
}))
vi.mock('./typesafe-advertising-local-meta-evidence', () => ({ fetchLocalMetaEvidence: vi.fn() }))

const policy = { ...advertisingTestPolicy, accountId: OLDACS_ACCOUNT_ID }
const evidence = {
  ...advertisingTestEvidence,
  source: 'local.meta.graph' as const,
  measuredAt: null,
  observation: advertisingTestLocalObservation,
  target: { ...advertisingTestEvidence.target, accountId: OLDACS_ACCOUNT_ID }
}
const now = Date.parse(evidence.fetchedAt)
const scope = { routineId: OLDACS_ROUTINE_ID, runId: 'run-1', isCurrent: () => true }
const authority = { token: 'test-only', isCurrent: () => true, assertCurrent: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  authority.assertCurrent.mockReset().mockResolvedValue(undefined)
  vi.mocked(authorizeLocalMetaRead).mockReset().mockResolvedValue(authority)
  vi.mocked(fetchLocalMetaEvidence).mockReset().mockResolvedValue([evidence])
  vi.mocked(fetchCoordinatorAdvertisingEvidence)
    .mockReset()
    .mockResolvedValue([advertisingTestEvidence])
})

describe('exact local advertising source selection', () => {
  it('keeps ordinary supported accounts on the signed coordinator', async () => {
    expect(
      await fetchAdvertisingEvidence([advertisingTestEvidence.target], advertisingTestPolicy, now)
    ).toEqual([advertisingTestEvidence])
    expect(fetchCoordinatorAdvertisingEvidence).toHaveBeenCalledOnce()
    expect(authorizeLocalMetaRead).not.toHaveBeenCalled()
    expect(fetchLocalMetaEvidence).not.toHaveBeenCalled()
  })

  it('uses local evidence only with the exact account and bound routine scope', async () => {
    expect(await fetchAdvertisingEvidence([evidence.target], policy, now, scope)).toEqual([
      evidence
    ])
    expect(authorizeLocalMetaRead).toHaveBeenCalledWith(scope, policy)
    expect(fetchLocalMetaEvidence).toHaveBeenCalledWith(
      [evidence.target],
      authority,
      expect.any(Object)
    )
    expect(authority.assertCurrent).toHaveBeenCalledOnce()
    expect(fetchCoordinatorAdvertisingEvidence).not.toHaveBeenCalled()
  })

  it('never converts a coordinator failure into a local vault fallback', async () => {
    vi.mocked(fetchCoordinatorAdvertisingEvidence).mockRejectedValue(
      new Error('Signed account unavailable')
    )
    await expect(
      fetchAdvertisingEvidence([advertisingTestEvidence.target], advertisingTestPolicy, now, scope)
    ).rejects.toThrow('Signed account unavailable')
    expect(authorizeLocalMetaRead).not.toHaveBeenCalled()
    expect(fetchLocalMetaEvidence).not.toHaveBeenCalled()
  })

  it('rejects missing scope and cross-account candidates before credential access', async () => {
    await expect(fetchAdvertisingEvidence([evidence.target], policy, now)).rejects.toThrow(
      'bound routine'
    )
    await expect(
      fetchAdvertisingEvidence([advertisingTestEvidence.target], policy, now, scope)
    ).rejects.toThrow('configured company and account')
    expect(authorizeLocalMetaRead).not.toHaveBeenCalled()
    expect(fetchLocalMetaEvidence).not.toHaveBeenCalled()
  })

  it('does not bypass denied or revoked local authority', async () => {
    vi.mocked(authorizeLocalMetaRead).mockRejectedValueOnce(new Error('Not authorized'))
    await expect(fetchAdvertisingEvidence([evidence.target], policy, now, scope)).rejects.toThrow(
      'Not authorized'
    )
    expect(fetchLocalMetaEvidence).not.toHaveBeenCalled()
    authority.assertCurrent.mockRejectedValueOnce(new Error('Read authority revoked'))
    await expect(fetchAdvertisingEvidence([evidence.target], policy, now, scope)).rejects.toThrow(
      'Read authority revoked'
    )
    expect(fetchCoordinatorAdvertisingEvidence).not.toHaveBeenCalled()
  })

  it('applies the same measured freshness guard to local observations', async () => {
    await expect(
      fetchAdvertisingEvidence([evidence.target], policy, now + 301_000, scope)
    ).rejects.toThrow('stale')
    expect(fetchCoordinatorAdvertisingEvidence).not.toHaveBeenCalled()
  })
})
