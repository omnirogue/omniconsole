import { BACKOFFICE_POLLING } from '../../../shared/backoffice-polling-cadence'
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleJobRecord, ConsoleWorkflowJob } from '../../../shared/console-workflow-types'

const mocks = vi.hoisted(() => ({
  scope: 'person-a',
  listJobs: vi.fn(),
  getWorkflow: vi.fn(),
  readFleetReceipts: vi.fn(),
  beginFleetAdmission: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: vi.fn() }))
vi.mock('@/lib/personal-view-storage', () => ({ personalViewStorageKey: () => mocks.scope }))
vi.mock('@/lib/console-workflow-client', () => ({
  consoleWorkflowApi: () => ({
    listJobs: mocks.listJobs,
    getWorkflow: mocks.getWorkflow,
    readFleetReceipts: mocks.readFleetReceipts,
    beginFleetAdmission: mocks.beginFleetAdmission
  }),
  workflowData: (result: { ok: boolean; data?: unknown; error?: { message: string } }) => {
    if (!result.ok) {
      throw new Error(result.error?.message)
    }
    return result.data
  },
  workflowErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error))
}))

import { refreshConversationFleet, useConversationFleetStore } from './conversation-fleet-store'
import {
  assertConversationFleetProgress,
  discoveredConversationFleetReceipts,
  type ConversationFleetReceipt
} from '@/lib/conversation-fleet-receipt'

const receipt: ConversationFleetReceipt = {
  workflowId: 'wf_12345678',
  taskId: 'btk_12345678',
  rowKey: 'chat/source',
  sessionKey: 'source-session',
  title: 'Source conversation',
  createdAt: '2026-09-12T20:00:00.000Z',
  machine: 'mw0002',
  digest: 'a'.repeat(64)
}

function job(extra: Partial<ConsoleWorkflowJob> = {}): ConsoleWorkflowJob {
  return {
    id: 'job_12345678',
    task_id: receipt.taskId,
    node_id: 'stage_one',
    title: 'Improve',
    status: 'running',
    actor_type: 'ai',
    provider: 'codex',
    model: 'gpt-6',
    effort: 'high',
    repo: null,
    machine: 'mw0002',
    pr_url: null,
    attempt: 1,
    lease_generation: 1,
    owned_paths: null,
    updated_at: '2026-09-12T20:05:00.000Z',
    blockers: [],
    workflow_state: 'running',
    can_decide: false,
    policy: {
      workflow: {
        version: 1,
        digest: receipt.digest!,
        mode: 'single_shot',
        dispatch_id: receipt.workflowId,
        workflow_id: receipt.workflowId,
        key: 'stage_one',
        actor_type: 'ai',
        actor_id: 'codex',
        action: 'execute',
        after: [],
        after_keys: [],
        require_merged: [],
        approval_ancestors: [],
        source_task_id: receipt.taskId,
        source: { session_ref: receipt.rowKey, session_id: receipt.sessionKey! }
      }
    },
    ...extra
  }
}

function succeed(jobs = [job()]) {
  mocks.getWorkflow.mockResolvedValue({ ok: true, data: { workflow_id: receipt.workflowId, jobs } })
}

function record(value: ConsoleWorkflowJob): ConsoleJobRecord {
  return {
    ...value,
    attempt: value.attempt ?? undefined,
    lease_generation: value.lease_generation ?? undefined
  }
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.restoreAllMocks()
  mocks.scope = 'person-a'
  mocks.readFleetReceipts
    .mockReset()
    .mockImplementation(async (legacy) => ({ ok: true, data: legacy }))
  mocks.beginFleetAdmission.mockReset().mockResolvedValue({ ok: true, data: true })
  mocks.listJobs.mockReset().mockResolvedValue({
    ok: true,
    data: { jobs: [], conversation_source_scope: 'directing_person' }
  })
  mocks.getWorkflow.mockReset()
  localStorage.clear()
  useConversationFleetStore.setState({ scope: null, runs: [], recoveryError: null, ready: false })
  await useConversationFleetStore.getState().load(mocks.scope)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('conversation admission recovery', () => {
  it('persists an uncertain admission and recovers a later accepted response after restart', async () => {
    const store = useConversationFleetStore.getState()
    expect(await store.beginAdmission(mocks.scope, receipt)).toBe(true)
    expect(JSON.parse(localStorage.getItem(mocks.scope)!)[0]).toMatchObject({
      workflowId: receipt.workflowId,
      digest: receipt.digest,
      admission: 'pending'
    })
    useConversationFleetStore.setState({ scope: null, runs: [] })
    await store.load(mocks.scope)
    mocks.getWorkflow.mockResolvedValue({
      ok: false,
      error: { message: 'No admitted graph carries this identity' }
    })
    await refreshConversationFleet(mocks.scope)
    expect(useConversationFleetStore.getState().runs[0]).toMatchObject({
      admission: 'pending',
      verified: false,
      jobs: [],
      error: 'No admitted graph carries this identity'
    })
    await vi.advanceTimersByTimeAsync(BACKOFFICE_POLLING.focusedMs)
    succeed()
    await refreshConversationFleet(mocks.scope)
    expect(useConversationFleetStore.getState().runs[0]).toMatchObject({
      admission: 'accepted',
      verified: true
    })
    expect(JSON.parse(localStorage.getItem(mocks.scope)!)[0].admission).toBe('accepted')
  })

  it('recovers only with the server owner-scope marker and a matching complete workflow read', async () => {
    mocks.listJobs.mockResolvedValue({ ok: true, data: { jobs: [job()] } })
    await refreshConversationFleet(mocks.scope)
    expect(useConversationFleetStore.getState().runs).toEqual([])
    expect(mocks.getWorkflow).not.toHaveBeenCalled()
    expect(useConversationFleetStore.getState().recoveryError).toContain('scope')
    mocks.listJobs.mockResolvedValue({
      ok: true,
      data: { jobs: [job()], conversation_source_scope: 'directing_person' }
    })
    succeed()
    await refreshConversationFleet(mocks.scope)
    expect(useConversationFleetStore.getState().runs).toHaveLength(1)
    expect(useConversationFleetStore.getState().runs[0]).toMatchObject({
      rowKey: receipt.rowKey,
      sessionKey: receipt.sessionKey,
      taskId: receipt.taskId,
      admission: 'accepted',
      verified: true
    })
    expect(mocks.listJobs).toHaveBeenCalledWith({ conversationSource: true })
  })

  it('never converts a mismatched or empty server response into admission proof', async () => {
    await useConversationFleetStore.getState().beginAdmission(mocks.scope, receipt)
    succeed([])
    await refreshConversationFleet(mocks.scope)
    expect(useConversationFleetStore.getState().runs[0]).toMatchObject({
      admission: 'pending',
      verified: false
    })
    const wrongSource = job()
    wrongSource.policy.workflow.source = { session_ref: 'other-chat' }
    await vi.advanceTimersByTimeAsync(BACKOFFICE_POLLING.focusedMs)
    succeed([wrongSource])
    await refreshConversationFleet(mocks.scope)
    expect(useConversationFleetStore.getState().runs[0]).toMatchObject({
      admission: 'pending',
      verified: false,
      error: 'The server returned a different conversation source.'
    })
  })

  it('fences discovery and admission responses across identity changes', async () => {
    let respond!: (result: unknown) => void
    mocks.listJobs.mockReturnValue(
      new Promise((resolve) => {
        respond = resolve
      })
    )
    const pending = refreshConversationFleet(mocks.scope)
    mocks.scope = 'person-b'
    await useConversationFleetStore.getState().load(mocks.scope)
    respond({ ok: true, data: { jobs: [job()], conversation_source_scope: 'directing_person' } })
    await pending
    expect(useConversationFleetStore.getState().runs).toEqual([])
    expect(useConversationFleetStore.getState().remember('person-a', receipt, [job()])).toBe(false)
    expect(useConversationFleetStore.getState().scope).toBe('person-b')
    expect(mocks.getWorkflow).not.toHaveBeenCalled()
  })

  it('keeps accepted status unverified on lost contact and rechecks completed jobs for server changes', async () => {
    useConversationFleetStore.getState().remember(mocks.scope, receipt, [job({ status: 'done' })])
    mocks.getWorkflow.mockRejectedValue(new Error('Disconnected'))
    await refreshConversationFleet(mocks.scope)
    expect(useConversationFleetStore.getState().runs[0]).toMatchObject({
      admission: 'accepted',
      verified: false,
      error: 'Disconnected'
    })
    await vi.advanceTimersByTimeAsync(BACKOFFICE_POLLING.focusedMs)
    succeed([job({ status: 'queued' })])
    await refreshConversationFleet(mocks.scope)
    expect(useConversationFleetStore.getState().runs[0].jobs[0].status).toBe('queued')
  })

  it('does not rely on renderer storage to commit pending intent', async () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('Quota')
      }
    })
    expect(await useConversationFleetStore.getState().beginAdmission(mocks.scope, receipt)).toBe(
      true
    )
    expect(mocks.beginFleetAdmission).toHaveBeenCalledOnce()
    expect(useConversationFleetStore.getState().runs[0].admission).toBe('pending')
  })

  it('fails closed when main-process storage refuses the receipt', async () => {
    mocks.beginFleetAdmission.mockResolvedValue({ ok: false, error: { message: 'Disk full' } })
    expect(await useConversationFleetStore.getState().beginAdmission(mocks.scope, receipt)).toBe(
      false
    )
    expect(useConversationFleetStore.getState().recoveryError).toBe('Disk full')
  })

  it('recovers main-process intent with an empty renderer cache and fences late account loads', async () => {
    mocks.readFleetReceipts.mockResolvedValue({
      ok: true,
      data: [{ ...receipt, admission: 'pending' }]
    })
    useConversationFleetStore.setState({ scope: null, ready: false, runs: [] })
    await useConversationFleetStore.getState().load(mocks.scope)
    expect(useConversationFleetStore.getState().runs[0].workflowId).toBe(receipt.workflowId)
    const later = Promise.withResolvers<unknown>()
    mocks.readFleetReceipts.mockReturnValueOnce(later.promise)
    const pending = useConversationFleetStore.getState().load('person-b')
    mocks.readFleetReceipts.mockResolvedValue({ ok: true, data: [] })
    await useConversationFleetStore.getState().load('person-c')
    later.resolve({ ok: true, data: [receipt] })
    await pending
    expect(useConversationFleetStore.getState().scope).toBe('person-c')
    expect(useConversationFleetStore.getState().runs).toEqual([])
  })

  it('dismisses only unconfirmed presentation and restores it when the server later admits it', async () => {
    const store = useConversationFleetStore.getState()
    await store.beginAdmission(mocks.scope, receipt)
    expect(store.dismissUnconfirmed(mocks.scope, receipt.workflowId)).toBe(true)
    expect(useConversationFleetStore.getState().runs).toEqual([])
    expect(mocks.getWorkflow).not.toHaveBeenCalled()
    mocks.listJobs.mockResolvedValue({
      ok: true,
      data: { jobs: [job()], conversation_source_scope: 'directing_person' }
    })
    succeed()
    await refreshConversationFleet(mocks.scope)
    expect(useConversationFleetStore.getState().runs[0].admission).toBe('accepted')
    expect(store.dismissUnconfirmed(mocks.scope, receipt.workflowId)).toBe(false)
  })
})

describe('server workflow association', () => {
  it('rejects duplicate canonical stage task IDs without changing legacy shared-task reads', () => {
    const first = job()
    const second = job({ id: 'job_87654321' })
    const progress = { workflow_id: receipt.workflowId, jobs: [first, second] }
    expect(() => assertConversationFleetProgress(receipt, progress)).toThrow('different workflow')
    delete first.policy.workflow.source_task_id
    delete second.policy.workflow.source_task_id
    expect(() => assertConversationFleetProgress(receipt, progress)).not.toThrow()
  })

  it('recovers separate delivery tasks through their exact sealed source outcome card', async () => {
    const delivery = job({
      task_id: 'btk_delivery123',
      actor_type: 'human',
      provider: null,
      model: null,
      effort: null,
      machine: null
    })
    delivery.policy.workflow = {
      ...delivery.policy.workflow,
      actor_type: 'human',
      actor_id: 'emp_sal',
      action: 'notify'
    }
    mocks.listJobs.mockResolvedValue({
      ok: true,
      data: { jobs: [record(delivery)], conversation_source_scope: 'directing_person' }
    })
    succeed([delivery])
    await refreshConversationFleet(mocks.scope)
    expect(useConversationFleetStore.getState().runs[0]).toMatchObject({
      taskId: receipt.taskId,
      admission: 'accepted',
      verified: true
    })
    const inconsistent = job({ id: 'job_87654321', task_id: 'btk_delivery456' })
    inconsistent.policy.workflow.source_task_id = 'btk_another123'
    expect(() =>
      assertConversationFleetProgress(receipt, {
        workflow_id: receipt.workflowId,
        jobs: [delivery, inconsistent]
      })
    ).toThrow('different workflow task')
    expect(
      discoveredConversationFleetReceipts(
        [record(delivery), record(inconsistent)],
        receipt.createdAt
      )
    ).toEqual([])
    delete inconsistent.policy.workflow.source_task_id
    expect(() =>
      assertConversationFleetProgress(receipt, {
        workflow_id: receipt.workflowId,
        jobs: [delivery, inconsistent]
      })
    ).toThrow('different workflow task')
  })

  it('recovers the sealed capture time instead of inventing one from discovery or admission', () => {
    const capturedAt = '2026-09-12T19:55:00.000Z'
    const capturedJob = job()
    capturedJob.policy.workflow.source = {
      ...capturedJob.policy.workflow.source,
      captured_at: capturedAt
    }
    const recovered = discoveredConversationFleetReceipts([record(capturedJob)], receipt.createdAt)
    expect(recovered[0]).toMatchObject({ capturedAt, createdAt: receipt.createdAt })
    expect(
      discoveredConversationFleetReceipts([record(job())], receipt.createdAt)[0].capturedAt
    ).toBeUndefined()
    expect(() =>
      assertConversationFleetProgress(
        { ...receipt, capturedAt },
        {
          workflow_id: receipt.workflowId,
          jobs: [capturedJob]
        }
      )
    ).not.toThrow()
    expect(() =>
      assertConversationFleetProgress(
        { ...receipt, capturedAt: receipt.createdAt },
        {
          workflow_id: receipt.workflowId,
          jobs: [capturedJob]
        }
      )
    ).toThrow('different conversation source')
  })

  it('refuses inconsistent source metadata, local jobs and unrelated records during discovery', () => {
    const different = job({ id: 'job_87654321' })
    different.policy.workflow.source = { session_ref: 'another-conversation' }
    const local = job()
    local.policy.workflow.placement = 'local'
    const ordinary: ConsoleJobRecord = {
      id: 'job_ordinary1',
      task_id: receipt.taskId,
      title: 'Ordinary',
      status: 'done',
      policy: {}
    }
    expect(
      discoveredConversationFleetReceipts(
        [record(job()), record(different), record(local), ordinary],
        receipt.createdAt
      )
    ).toEqual([])
  })

  it('validates every job digest, identity and source, while allowing node-specific task IDs', () => {
    const child = job({ id: 'job_87654321', task_id: 'btk_child123' })
    expect(() =>
      assertConversationFleetProgress(receipt, {
        workflow_id: receipt.workflowId,
        jobs: [job(), child]
      })
    ).not.toThrow()
    child.policy.workflow.digest = 'b'.repeat(64)
    expect(() =>
      assertConversationFleetProgress(receipt, {
        workflow_id: receipt.workflowId,
        jobs: [job(), child]
      })
    ).toThrow('different workflow')
  })
})
