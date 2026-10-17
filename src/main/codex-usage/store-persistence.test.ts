import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CodexUsagePersistedState } from './types'
import { createStoreWithState, setupCodexUsageStoreEnv } from './store-test-harness'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/omni-test-userdata')
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('./codex-usage-worker-client', () => ({
  scanCodexUsageFilesInWorker: vi.fn()
}))

import { CodexUsageStore, normalizePersistedState } from './store'
import { UsageScanStoppedError } from '../usage/usage-scan-stopped-error'
import { scanCodexUsageFilesInWorker } from './codex-usage-worker-client'

describe('CodexUsageStore', () => {
  const storeEnv = setupCodexUsageStoreEnv(getPathMock)

  it('adapts Codex scans to compact cache persistence', async () => {
    const store = createStoreWithState({
      schemaVersion: 5,
      scanState: {
        enabled: true,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null
      }
    })

    await store.refresh(true)

    const persistedJson = readFileSync(
      join(storeEnv.tempUserData, 'omni-codex-usage.json'),
      'utf-8'
    )
    expect(scanCodexUsageFilesInWorker).toHaveBeenCalledWith(
      [],
      [],
      expect.objectContaining({ worktreeSetChanged: true })
    )
    expect(persistedJson).toBe(JSON.stringify(JSON.parse(persistedJson)))
  })

  it('writes worker checkpoints verbatim and resumes their sources after relaunch', async () => {
    const store = createStoreWithState({
      schemaVersion: 5,
      scanState: {
        enabled: true,
        lastScanStartedAt: null,
        lastScanCompletedAt: 123,
        lastScanError: null
      }
    })
    const sources = [{ path: '/settled.jsonl', ownedEventKeys: ['event'], attributionByCwd: {} }]
    vi.mocked(scanCodexUsageFilesInWorker).mockImplementationOnce(async (_refs, _previous, options) => {
      expect(options?.checkpointState?.processedFiles).toEqual([])
      const snapshot = JSON.stringify({ ...options?.checkpointState, processedFiles: sources })
      await options?.onSerializedCheckpoint?.(snapshot)
      expect(readFileSync(join(storeEnv.tempUserData, 'omni-codex-usage.json'), 'utf-8')).toBe(snapshot)
      throw new UsageScanStoppedError('stopped')
    })
    await expect(store.refresh(true)).resolves.toMatchObject({
      lastScanError: null,
      lastScanCompletedAt: 123
    })
    const relaunched = new CodexUsageStore({ getRepos: () => [], getAllWorktreeMeta: () => ({}) })
    await relaunched.refresh(true)
    expect(scanCodexUsageFilesInWorker).toHaveBeenLastCalledWith([], sources, expect.any(Object))
    await relaunched.flush()
  })

  it.each([false, true])('ignores stopped checkpoints even after re-enabling: %s', async (reenable) => {
    const store = createStoreWithState({
      schemaVersion: 5,
      scanState: {
        enabled: true,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null
      }
    })
    vi.mocked(scanCodexUsageFilesInWorker).mockImplementationOnce(async (_refs, _previous, options) => {
      await store.setEnabled(false)
      if (reenable) {
        await store.setEnabled(true)
      }
      expect(options?.shouldStop?.()).toBe(true)
      await options?.onSerializedCheckpoint?.('{"scanState":{"enabled":true}}')
      throw new UsageScanStoppedError('stopped')
    })
    await expect(store.refresh(true)).resolves.toMatchObject({
      enabled: reenable,
      lastScanError: null
    })
    const persisted = JSON.parse(
      readFileSync(join(storeEnv.tempUserData, 'omni-codex-usage.json'), 'utf-8')
    )
    expect(persisted.scanState.enabled).toBe(reenable)
  })

  it('drops persisted caches from older schemas that lack scoped model breakdown data', () => {
    const normalized = normalizePersistedState({
      schemaVersion: 1,
      processedFiles: [],
      sessions: [
        {
          sessionId: 'legacy',
          firstTimestamp: '2026-04-09T10:00:00.000Z',
          lastTimestamp: '2026-04-09T10:10:00.000Z',
          primaryModel: 'gpt-5',
          hasMixedModels: false,
          primaryProjectLabel: 'Repo',
          hasMixedLocations: false,
          primaryWorktreeId: 'repo-1::/workspace/repo',
          primaryRepoId: 'repo-1',
          eventCount: 1,
          totalInputTokens: 1,
          totalCachedInputTokens: 0,
          totalOutputTokens: 1,
          totalReasoningOutputTokens: 0,
          totalTokens: 2,
          hasInferredPricing: false,
          locationBreakdown: [],
          modelBreakdown: []
        }
      ],
      dailyAggregates: [],
      scanState: {
        enabled: true,
        lastScanStartedAt: 1,
        lastScanCompletedAt: 2,
        lastScanError: null
      }
    } as unknown as CodexUsagePersistedState)

    expect(normalized).toEqual({
      schemaVersion: 5,
      worktreeFingerprint: null,
      processedFiles: [],
      sessions: [],
      dailyAggregates: [],
      scanState: {
        enabled: true,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null
      }
    })
  })
})
