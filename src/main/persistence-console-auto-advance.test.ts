import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../shared/persisted-state-types'
import {
  createStore,
  dataFile,
  readDataFile,
  testState,
  writeDataFile
} from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))

const workflowId = 'wf_auto_advance_fixture'
const worktree = 'id:wt-console-1'

describe('console auto-advance preference persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'omni-auto-advance-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('defaults to off for a workflow the person never configured', () => {
    const store = createStore()
    const { status, ...row } = store.getConsoleAutoAdvance(workflowId)
    expect(row).toEqual({ workflowId, enabled: false, worktree: '' })
    expect(status).toMatchObject({ state: 'off', reason: null, jobId: null, detail: null })
    expect(store.listConsoleAutoAdvance()).toEqual([])
  })

  it('round-trips one enabled workflow through the main state file', () => {
    const store = createStore()
    const saved = store.setConsoleAutoAdvance({ workflowId, enabled: true, worktree })
    expect(saved).toMatchObject({ workflowId, enabled: true, worktree })
    store.recordConsoleAutoAdvanceStatus(workflowId, {
      state: 'waiting',
      reason: null,
      jobId: null,
      detail: null,
      updatedAt: 5
    })
    store.flushOrThrow()
    expect(
      (readDataFile() as PersistedState).consoleWorkflowAutoAdvance?.[workflowId]
    ).toMatchObject({ enabled: true, worktree, status: { state: 'waiting' } })
    expect(createStore().getConsoleAutoAdvance(workflowId)).toMatchObject({
      enabled: true,
      worktree,
      status: { state: 'waiting', updatedAt: 5 }
    })
    expect(dataFile()).toContain('omni-data.json')
  })

  it('clears the running status when the person turns it off', () => {
    const store = createStore()
    store.setConsoleAutoAdvance({ workflowId, enabled: true, worktree })
    store.recordConsoleAutoAdvanceStatus(workflowId, {
      state: 'activated',
      reason: null,
      jobId: 'job_abcdefgh',
      detail: null,
      updatedAt: 9
    })
    const off = store.setConsoleAutoAdvance({ workflowId, enabled: false })
    expect(off).toMatchObject({ enabled: false, worktree, status: { state: 'off', jobId: null } })
    expect(
      store.recordConsoleAutoAdvanceStatus(workflowId, {
        state: 'waiting',
        reason: null,
        jobId: null,
        detail: null,
        updatedAt: 10
      })
    ).toMatchObject({ enabled: false, status: { state: 'off' } })
  })

  it('refuses to enable without an approved workspace and drops unreadable saved rows', () => {
    writeDataFile({
      schemaVersion: 1,
      consoleWorkflowAutoAdvance: {
        [workflowId]: { workflowId, enabled: true, worktree: 42, status: { state: 'waiting' } },
        'not-a-workflow': { enabled: true, worktree }
      }
    })
    const store = createStore()
    expect(store.getConsoleAutoAdvance(workflowId)).toMatchObject({ enabled: false, worktree: '' })
    expect(store.listConsoleAutoAdvance()).toHaveLength(1)
    expect(() => store.setConsoleAutoAdvance({ workflowId, enabled: true })).toThrow(
      /workspace this workflow may activate/
    )
    expect(() => store.getConsoleAutoAdvance('wf-bad')).toThrow(/admitted workflow/)
  })
})
