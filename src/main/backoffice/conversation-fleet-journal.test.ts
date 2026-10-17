import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationFleetJournal } from './conversation-fleet-journal'
import * as durable from '../durable-file-write'
import { pendingReceipt, progressJob } from './conversation-fleet-journal-fixture'

let directory: string
let path: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'fleet-journal-'))
  path = join(directory, 'receipts.json')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe('durable fleet admission journal', () => {
  it('retains operation, exact SSH source, reviewed graph and full provider/model through restart', () => {
    const receipt = pendingReceipt()
    expect(new ConversationFleetJournal(path).begin(receipt)).toBe(true)
    const reopened = new ConversationFleetJournal(path)
    expect(reopened.list()).toEqual([receipt])
    expect(reopened.begin(receipt)).toBe(false)
    expect(reopened.claim(receipt.intent!.request)).toBe('send')
    expect(new ConversationFleetJournal(path).claim(receipt.intent!.request)).toBe('reconcile')
  })

  it('refuses another workflow for an unresolved task or source, including cancelled jobs', () => {
    const receipt = pendingReceipt()
    const store = new ConversationFleetJournal(path)
    store.begin(receipt)
    const next = structuredClone(receipt)
    next.workflowId = next.intent!.request.graph.dispatch_id = 'wf_another'
    next.intent!.operationId = 'operation-two'
    expect(store.begin(next)).toBe(false)
    store.observe({ workflow_id: receipt.workflowId, jobs: [progressJob('cancelled')] })
    expect(store.begin(next)).toBe(false)
    store.observe({ workflow_id: receipt.workflowId, jobs: [progressJob('done')] })
    expect(store.begin(next)).toBe(true)
  })

  it('rejects corrupt storage and changed graph identities instead of assuming absence', () => {
    const receipt = pendingReceipt()
    const store = new ConversationFleetJournal(path)
    store.begin(receipt)
    expect(() => store.claim({ ...receipt.intent!.request, expectedRevision: 8 })).toThrow('exact')
    writeFileSync(path, '{broken')
    expect(() => store.begin(receipt)).toThrow()
    expect(() => store.list()).toThrow()
  })

  it('does not consume an operation when its durable write fails', () => {
    const receipt = pendingReceipt()
    const store = new ConversationFleetJournal(path)
    store.begin(receipt)
    const write = vi.spyOn(durable, 'writeFileDurableSync').mockImplementation(() => {
      throw new Error('Disk full')
    })
    expect(() => store.claim(receipt.intent!.request)).toThrow('Disk full')
    write.mockRestore()
    expect(store.claim(receipt.intent!.request)).toBe('send')
  })

  it('preserves the admission receipt and refuses wrong source evidence', () => {
    const receipt = pendingReceipt()
    const store = new ConversationFleetJournal(path)
    store.begin(receipt)
    const job = progressJob()
    job.policy.workflow.source = { session_ref: 'other-source' }
    expect(() => store.observe({ workflow_id: receipt.workflowId, jobs: [job] })).toThrow('source')
    const admitted = {
      workflow_id: receipt.workflowId,
      jobs: [progressJob()],
      receipt: { admitted: true }
    }
    store.observe(admitted, admitted)
    expect(JSON.parse(readFileSync(path, 'utf8'))[0].admissionReceipt).toEqual(admitted.receipt)
    expect(new ConversationFleetJournal(path).list()[0].admission).toBe('accepted')
  })

  it('imports renderer-only pending intent conservatively and keeps accounts isolated', () => {
    const legacy = { ...pendingReceipt(), intent: undefined }
    const first = new ConversationFleetJournal(path)
    first.importLegacy([legacy])
    expect(first.begin(pendingReceipt())).toBe(false)
    expect(() => first.claim(pendingReceipt().intent!.request)).toThrow()
    const second = new ConversationFleetJournal(join(directory, 'other-person.json'))
    expect(second.list()).toEqual([])
    expect(second.begin(pendingReceipt())).toBe(true)
  })
})

it('does not grant replay authority to pre-upgrade attempted rows with unknown provenance', () => {
  const receipt = pendingReceipt()
  writeFileSync(path, JSON.stringify([{ receipt, attempted: true, settled: false }]))
  const store = new ConversationFleetJournal(path)
  expect(store.pendingRequests()).toEqual([])
  expect(() => store.claim(receipt.intent!.request)).toThrow('replay authority')
  expect(store.list()).toEqual([receipt])
})

it('upgrades proven unattempted main-process intent without changing the original approval', () => {
  const receipt = pendingReceipt()
  writeFileSync(path, JSON.stringify([{ receipt, attempted: false, settled: false }]))
  const store = new ConversationFleetJournal(path)
  expect(store.pendingRequests()).toEqual([receipt.intent!.request])
  expect(store.claim(receipt.intent!.request)).toBe('send')
  expect(new ConversationFleetJournal(path).claim(receipt.intent!.request)).toBe('reconcile')
})
