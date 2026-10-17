import { describe, expect, it, vi } from 'vitest'
import type { AdvertisingDecisionEnvelope } from '../../shared/typesafe-advertising'
import {
  withAdvertisingSelectionObjectLock,
  type AdvertisingActionStore
} from './advertising-action-store'
import { advertisingTestEnvelope } from './typesafe-advertising-fixtures'
import { localActionEnvelope } from './local-advertising-action-service-fixtures'

vi.mock('../backoffice/console-workflow-person', () => ({ captureConsoleWorkflowPerson: vi.fn() }))
vi.mock('./typesafe-advertising-coordinator', () => ({
  fetchCoordinatorAdvertisingEvidence: vi.fn()
}))
vi.mock('./local-meta-read-authority', () => ({ authorizeLocalMetaRead: vi.fn() }))
vi.mock('./typesafe-advertising-local-meta-evidence', () => ({ fetchLocalMetaEvidence: vi.fn() }))

function selection(envelope: AdvertisingDecisionEnvelope) {
  return {
    automationId: envelope.routineId,
    runId: envelope.runId,
    decisionId: envelope.decisions[0].id
  }
}

function storeFor(envelope: AdvertisingDecisionEnvelope): AdvertisingActionStore {
  return {
    loadEnvelope: vi.fn().mockResolvedValue(envelope),
    loadPolicy: vi.fn(),
    loadAction: vi.fn(),
    saveAction: vi.fn()
  }
}

describe('advertising object lock admission', () => {
  it('preserves ordinary execution for a valid signed-backend decision', async () => {
    const envelope = advertisingTestEnvelope()
    const store = storeFor(envelope)
    const work = vi.fn().mockResolvedValue('signed result')
    await expect(
      withAdvertisingSelectionObjectLock(store, selection(envelope), work)
    ).resolves.toBe('signed result')
    expect(work).toHaveBeenCalledOnce()
    expect(store.loadEnvelope).toHaveBeenCalledExactlyOnceWith(envelope.routineId, envelope.runId, {
      verificationOnly: true
    })
  })

  it('requires the host object lock for a validated local decision', async () => {
    const envelope = localActionEnvelope()
    const work = vi.fn()
    await expect(
      withAdvertisingSelectionObjectLock(storeFor(envelope), selection(envelope), work)
    ).rejects.toThrow(/object action lock/)
    expect(work).not.toHaveBeenCalled()
  })

  it('executes local work only after admission by the exact account and object lock', async () => {
    const envelope = localActionEnvelope()
    const target = envelope.decisions[0].target
    const store = storeFor(envelope)
    const events: string[] = []
    store.withObjectLock = async (accountId, nativeId, work) => {
      expect([accountId, nativeId]).toEqual([target.accountId, target.nativeId])
      events.push('locked')
      const result = await work()
      events.push('released')
      return result
    }
    const work = vi.fn(async () => {
      expect(events).toEqual(['locked'])
      events.push('work')
      return 'local result'
    })
    await expect(
      withAdvertisingSelectionObjectLock(store, selection(envelope), work)
    ).resolves.toBe('local result')
    expect(events).toEqual(['locked', 'work', 'released'])
  })

  it.each([
    'absent',
    'missing decision',
    'blocked',
    'invalid schema',
    'different routine',
    'different run'
  ])('refuses an initially %s envelope before subsequent work or reads', async (kind) => {
    const envelope = localActionEnvelope()
    const selected = selection(envelope)
    const initial = structuredClone(envelope)
    if (kind === 'missing decision') {
      initial.decisions = []
    }
    if (kind === 'blocked') {
      initial.status = 'blocked'
    }
    if (kind === 'invalid schema') {
      initial.policy.minConfidence = 2
    }
    if (kind === 'different routine') {
      initial.routineId = 'other-routine'
    }
    if (kind === 'different run') {
      initial.runId = 'other-run'
    }
    const store = storeFor(envelope)
    vi.mocked(store.loadEnvelope).mockResolvedValueOnce(kind === 'absent' ? null : initial)
    const work = vi.fn(async () => {
      await store.loadEnvelope(selected.automationId, selected.runId)
    })
    await expect(withAdvertisingSelectionObjectLock(store, selected, work)).rejects.toThrow(
      /decision is unavailable/
    )
    expect(work).not.toHaveBeenCalled()
    expect(store.loadEnvelope).toHaveBeenCalledOnce()
  })

  it.each(['same object', 'different object'])(
    'keeps separate runs under their %s lock scope',
    async (scope) => {
      const first = localActionEnvelope()
      const second = localActionEnvelope()
      second.runId = 'run-2'
      second.decisions[0].id = '6'.repeat(64)
      if (scope === 'different object') {
        second.decisions[0].target.nativeId = '999999'
        second.decisions[0].target.adsetId = '999999'
      }
      const store = storeFor(first)
      store.loadEnvelope = vi.fn(async (_routineId, runId) =>
        runId === first.runId ? first : second
      )
      const locks = new Map<string, Promise<unknown>>()
      const requested: string[] = []
      store.withObjectLock = async (accountId, nativeId, work) => {
        const key = `${accountId}:${nativeId}`
        requested.push(key)
        const result = (locks.get(key) ?? Promise.resolve()).then(work)
        locks.set(key, result)
        return result
      }
      let active = 0
      let peak = 0
      const work = async () => {
        active++
        peak = Math.max(peak, active)
        await Promise.resolve()
        active--
      }
      await Promise.all([
        withAdvertisingSelectionObjectLock(store, selection(first), work),
        withAdvertisingSelectionObjectLock(store, selection(second), work)
      ])
      expect(requested).toHaveLength(2)
      expect(new Set(requested).size).toBe(scope === 'same object' ? 1 : 2)
      expect(peak).toBe(scope === 'same object' ? 1 : 2)
      expect(active).toBe(0)
    }
  )
})
