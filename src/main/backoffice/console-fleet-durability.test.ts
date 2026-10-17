import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginFleetAdmission,
  durableFleetAdmission,
  readFleetReceipts
} from './console-fleet-durability'
import { pendingReceipt, progressJob } from './conversation-fleet-journal-fixture'
import * as durable from '../durable-file-write'

const state = vi.hoisted(() => ({ directory: '', scope: 'a'.repeat(64) }))
vi.mock('../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => state.directory
}))
vi.mock('./console-workflow-person', () => ({
  captureConsoleFleetReceiptScope: () => {
    const key = state.scope
    return { key, isCurrent: () => state.scope === key }
  },
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

beforeEach(() => {
  state.directory = mkdtempSync(join(tmpdir(), 'fleet-durability-'))
  state.scope = 'a'.repeat(64)
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(state.directory, { recursive: true, force: true })
})

describe('main-process admission boundary', () => {
  it('sends nothing without durable intent or when the attempt fsync fails', async () => {
    const receipt = pendingReceipt()
    const send = vi.fn()
    const read = vi.fn()
    expect((await durableFleetAdmission(receipt.intent!.request, send, read)).ok).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(await beginFleetAdmission(receipt)).toEqual({ ok: true, data: true })
    vi.spyOn(durable, 'writeFileDurableSync').mockImplementation(() => {
      throw new Error('Disk full')
    })
    expect((await durableFleetAdmission(receipt.intent!.request, send, read)).ok).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('reconciles one workflow after timeout and restart without repeating initial admission', async () => {
    const receipt = pendingReceipt()
    await beginFleetAdmission(receipt)
    const send = vi.fn().mockRejectedValue(new Error('Timeout after acceptance'))
    const read = vi.fn().mockResolvedValue({
      ok: true,
      data: { workflow_id: receipt.workflowId, jobs: [progressJob()], receipt: { canonical: true } }
    })
    expect((await durableFleetAdmission(receipt.intent!.request, send, read)).ok).toBe(false)
    expect(await readFleetReceipts()).toMatchObject({ ok: true, data: [{ admission: 'pending' }] })
    expect((await durableFleetAdmission(receipt.intent!.request, send, read)).ok).toBe(true)
    expect(send).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledOnce()
    expect(await readFleetReceipts()).toMatchObject({ ok: true, data: [{ admission: 'accepted' }] })
  })

  it('reconciles pending startup receipts before returning the restored collection', async () => {
    const receipt = pendingReceipt()
    await beginFleetAdmission(receipt)
    const pending = Promise.withResolvers<{
      ok: true
      data: { workflow_id: string; jobs: ReturnType<typeof progressJob>[] }
    }>()
    const read = vi.fn(() => pending.promise)
    let restored = false
    const recovery = readFleetReceipts([], read).then((result) => {
      restored = true
      return result
    })
    await Promise.resolve()
    expect(restored).toBe(false)
    expect(read).toHaveBeenCalledExactlyOnceWith(receipt.workflowId)
    pending.resolve({ ok: true, data: { workflow_id: receipt.workflowId, jobs: [progressJob()] } })
    expect(await recovery).toMatchObject({ ok: true, data: [{ admission: 'accepted' }] })
  })

  it('sends a provably unattempted saved intent once after restart', async () => {
    const receipt = pendingReceipt()
    await beginFleetAdmission(receipt)
    const send = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        workflow_id: receipt.workflowId,
        jobs: [progressJob()],
        receipt: { admitted: true }
      }
    })
    const read = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'No graph' } })
    const resume = vi.fn((request) => durableFleetAdmission(request, send, read))
    expect(await readFleetReceipts([], read, undefined, resume)).toMatchObject({
      ok: true,
      data: [{ admission: 'accepted' }]
    })
    expect(send).toHaveBeenCalledOnce()
    await readFleetReceipts([], read, undefined, resume)
    expect(send).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledOnce()
  })

  it('serializes competing renderer admits and does not interpret 404 as permission to retry', async () => {
    const receipt = pendingReceipt()
    await beginFleetAdmission(receipt)
    const pending = Promise.withResolvers<never>()
    const send = vi.fn().mockReturnValue(pending.promise)
    const read = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'No graph yet' } })
    const first = durableFleetAdmission(receipt.intent!.request, send, read)
    expect((await durableFleetAdmission(receipt.intent!.request, send, read)).ok).toBe(false)
    pending.reject(new Error('Disconnected'))
    await first
    expect(send).toHaveBeenCalledOnce()
    expect(await beginFleetAdmission(receipt)).toEqual({ ok: true, data: false })
  })

  it('keeps old-account acceptance in its own journal and never exposes it to another account', async () => {
    const receipt = pendingReceipt()
    await beginFleetAdmission(receipt)
    const send = vi.fn(async () => {
      state.scope = 'b'.repeat(64)
      return {
        ok: true as const,
        data: { workflow_id: receipt.workflowId, jobs: [progressJob()], receipt: {} }
      }
    })
    await durableFleetAdmission(receipt.intent!.request, send, vi.fn())
    expect(await readFleetReceipts()).toEqual({ ok: true, data: [] })
    state.scope = 'a'.repeat(64)
    expect(await readFleetReceipts()).toMatchObject({
      ok: true,
      data: [{ workflowId: receipt.workflowId, admission: 'accepted' }]
    })
  })
})

it('recovers attempted intent through the canonical callback even when the jobs projection is missing', async () => {
  const receipt = pendingReceipt()
  await beginFleetAdmission(receipt)
  const send = vi.fn().mockRejectedValue(new Error('lost reply'))
  const reconcile = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      workflow_id: receipt.workflowId,
      jobs: [progressJob()],
      receipt: { canonical: true }
    }
  })
  await durableFleetAdmission(receipt.intent!.request, send, reconcile)
  const resume = vi.fn((request) => durableFleetAdmission(request, send, reconcile))
  const read = vi
    .fn()
    .mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'No projection' } })
  expect(await readFleetReceipts([], read, undefined, resume)).toMatchObject({
    ok: true,
    data: [{ admission: 'accepted', intent: receipt.intent }]
  })
  expect(resume).toHaveBeenCalledExactlyOnceWith(receipt.intent!.request)
  expect(send).toHaveBeenCalledOnce()
  expect(reconcile).toHaveBeenCalledOnce()
})

it('never treats renderer legacy intent as retained admission authority', async () => {
  const resume = vi.fn()
  const read = vi
    .fn()
    .mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'Missing' } })
  const result = await readFleetReceipts([pendingReceipt()], read, undefined, resume)
  expect(result).toMatchObject({ ok: true, data: [{ admission: 'pending' }] })
  if (!result.ok) {
    throw new Error('Legacy receipt import failed')
  }
  expect(result.data).toHaveLength(1)
  expect(result.data[0]).not.toHaveProperty('intent')
  expect(resume).not.toHaveBeenCalled()
})
