import { expect, it, vi } from 'vitest'
import { exactHandoffFile, handoffThreadUpload } from './console-handoff-contract'
import { partitionCardlessAttachments } from './session-follow-up-cardless-delivery'
import { deliverSessionFollowUp } from './session-follow-up-delivery'
import { normalizeSessionFollowUpRule, type SessionFollowUpRule } from './session-follow-up-rule'

const MiB = 1024 * 1024
const file = { name: 'video.mov', size: 25 * MiB, sha256: 'a'.repeat(64), contentBase64: 'YQ==' }
const upload = { threadId: 'hth_thread', file, note: 'Review this.', operationId: 'operation_123' }
const rule = (): SessionFollowUpRule => ({
  revision: 1,
  taskId: null,
  taskTitle: 'Review',
  sessionLabel: 'Work',
  recipients: [
    { employeeId: 'emp_person', name: 'Person', operationId: 'operation_123', delivery: 'pending' }
  ],
  deliverables: { kind: 'files', paths: ['/w/video.mov'] },
  includeSummary: false,
  note: 'Review this.',
  savedAt: 1,
  capturedAt: 2,
  files: [{ sourcePath: '/w/video.mov', name: file.name, size: file.size, sha256: file.sha256 }]
})

it('keeps create and card pins at 10 MiB while thread uploads accept exactly 25 MiB', () => {
  expect(exactHandoffFile.safeParse(file).success).toBe(false)
  expect(exactHandoffFile.safeParse({ ...file, size: 10 * MiB }).success).toBe(true)
  expect(handoffThreadUpload.safeParse(upload).success).toBe(true)
  expect(
    handoffThreadUpload.safeParse({ ...upload, file: { ...file, size: file.size + 1 } }).success
  ).toBe(false)
  expect(partitionCardlessAttachments([file], Number.POSITIVE_INFINITY)).toEqual({
    withCreate: [],
    afterwards: [file]
  })
})

it.each([undefined, false, 'true', true])(
  'normalizes explicit working-tree opt-in %s and preserves large thread pins',
  (includeWorkingTree) => {
    const saved = normalizeSessionFollowUpRule({ ...rule(), includeWorkingTree })
    expect(saved?.includeWorkingTree).toBe(includeWorkingTree === true ? true : undefined)
    expect(saved?.files).toEqual(rule().files)
    expect(saved?.capturedAt).toBe(2)
  }
)

it('replays a large follow-on upload under the persisted key after a lost receipt and restart', async () => {
  let saved = rule()
  let current = saved
  const serverUploads = new Set<string>()
  let loseReceipt = true
  const hub = {
    upload: vi.fn(),
    send: vi.fn(),
    isRejected: () => false,
    sendCardless: vi.fn(async () => ({ thread_id: 'hth_thread' })),
    uploadThreadFile: vi.fn(async (input: typeof upload) => {
      expect(saved.recipients[0]?.delivery).toBe('sending')
      serverUploads.add(input.operationId)
      if (loseReceipt) {
        throw new Error('Lost upload receipt')
      }
      return { thread_id: input.threadId }
    })
  }
  const context = {
    current: () => current,
    save: async (next: SessionFollowUpRule) => {
      current = next
      saved = structuredClone(next)
    },
    hub,
    bytes: vi.fn(async () => file),
    now: () => 3,
    sleep: async () => {}
  }
  await expect(deliverSessionFollowUp(context)).rejects.toMatchObject({ code: 'unconfirmed' })
  current = normalizeSessionFollowUpRule(saved)!
  loseReceipt = false
  await expect(deliverSessionFollowUp(context)).resolves.toBe('delivered')
  expect(serverUploads.size).toBe(1)
  expect(hub.sendCardless).toHaveBeenCalledWith(expect.objectContaining({ attachments: [] }))
  expect(saved.recipients[0]?.threadId).toBe('hth_thread')
  const calls = hub.uploadThreadFile.mock.calls.length
  current = normalizeSessionFollowUpRule(saved)!
  await expect(deliverSessionFollowUp(context)).resolves.toBe('delivered')
  expect(hub.uploadThreadFile).toHaveBeenCalledTimes(calls)
})
