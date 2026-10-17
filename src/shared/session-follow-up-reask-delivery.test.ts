import { describe, expect, it, vi } from 'vitest'
import type { ExactHandoffFile, HandoffDetail } from './console-handoff-contract'
import { deliverSessionFollowUp } from './session-follow-up-delivery'
import type { FollowUpDeliveryContext } from './session-follow-up-delivery-contract'
import { normalizeSessionFollowUpRule, type SessionFollowUpRule } from './session-follow-up-rule'

const operationId = 'round_two_operation'
const threadId = 'hth_existing'
const file = (name: string, sha256 = 'a'.repeat(64)): ExactHandoffFile => ({
  name,
  sha256,
  size: 3,
  contentBase64: 'YWJj'
})
const currentFile = (name: string, sha256: string) => ({
  id: `hfv_${name.replace(/\W/g, '_')}`,
  name,
  sha256,
  current: true,
  available: true,
  version: 1,
  parent_version_id: null,
  path: name,
  size: 3
})

function fixture(files = [file('work.md')]) {
  let rule: SessionFollowUpRule = {
    revision: 1,
    taskId: null,
    taskTitle: 'Work',
    sessionLabel: 'Session',
    reask: true,
    recipients: [
      {
        employeeId: 'emp_person',
        name: 'Person',
        operationId,
        threadId,
        round: 2,
        delivery: 'pending'
      }
    ],
    deliverables: { kind: 'files', paths: [] },
    includeSummary: true,
    note: 'Review',
    request: { title: 'Work', description: 'Please review the changes.' },
    disposition: 'ownership-transfer',
    savedAt: 1,
    capturedAt: 2,
    files: files.map(({ name, sha256, size }) => ({ name, sha256, size, sourcePath: name }))
  }
  const receipt = { thread_id: threadId }
  const hub = {
    get: vi.fn(async (): Promise<HandoffDetail> => ({
      files: [],
      entries: [],
      reviews: [],
      thread: {
        id: threadId,
        board_task_id: null,
        author_employee_id: 'emp_author',
        recipient_employee_id: 'emp_person',
        title: 'Work',
        state: 'open',
        action: null,
        due_at: null,
        parent_thread_id: null,
        delivery_id: null,
        updated: ''
      }
    })),
    respond: vi.fn(async () => receipt),
    returnFile: vi.fn(async () => receipt),
    uploadThreadFile: vi.fn(async () => receipt),
    send: vi.fn(async () => receipt),
    sendCardless: vi.fn(async () => receipt),
    upload: vi.fn(),
    isRejected: vi.fn(() => false)
  }
  const ctx: FollowUpDeliveryContext = {
    current: () => rule,
    save: async (value) => {
      rule = value
    },
    hub,
    bytes: async (pin) => files.find((entry) => entry.name === pin.name)!,
    now: () => 5,
    sleep: vi.fn()
  }
  return { ctx, hub, rule: () => rule }
}

describe('follow-up re-asks', () => {
  it.each(['no reask', 'round one', 'no round', 'no thread', 'no get'])(
    '%s uses the opening path',
    async (mode) => {
      const f = fixture()
      if (mode === 'no reask') {
        delete f.rule().reask
      }
      if (mode === 'round one') {
        f.rule().recipients[0]!.round = 1
      }
      if (mode === 'no round') {
        delete f.rule().recipients[0]!.round
      }
      if (mode === 'no thread') {
        delete f.rule().recipients[0]!.threadId
      }
      if (mode === 'no get') {
        delete f.ctx.hub.get
      }
      await deliverSessionFollowUp(f.ctx)
      expect(f.hub.sendCardless).toHaveBeenCalledOnce()
      expect(f.hub.respond).not.toHaveBeenCalled()
    }
  )

  it('matches current names, versions changed files, preserves summary name and omits transcript', async () => {
    const files = ['same.md', 'changed.md', 'new.md', 'Summary.md', 'Transcript.md'].map((name) =>
      file(name)
    )
    const f = fixture(files)
    f.rule().summaryFile = 'Summary.md'
    f.rule().files![4]!.generatedKind = 'transcript'
    const detail = await f.hub.get()
    detail.files = [
      currentFile('same.md', files[0]!.sha256),
      currentFile('changed.md', 'b'.repeat(64)),
      currentFile('Summary.md', files[3]!.sha256),
      currentFile('vanished.md', 'c'.repeat(64))
    ]
    f.hub.get.mockResolvedValue(detail)
    f.hub.get.mockClear()
    await deliverSessionFollowUp(f.ctx)
    expect(f.hub.send).not.toHaveBeenCalled()
    expect(f.hub.sendCardless).not.toHaveBeenCalled()
    expect(f.hub.upload).not.toHaveBeenCalled()
    expect(f.hub.returnFile.mock.calls).toEqual([
      [
        expect.objectContaining({
          file: files[1],
          baseVersionId: 'hfv_changed_md',
          operationId: `${operationId}_v1`
        })
      ],
      [
        expect.objectContaining({
          file: files[3],
          baseVersionId: 'hfv_Summary_md',
          operationId: `${operationId}_v3`
        })
      ]
    ])
    expect(f.hub.uploadThreadFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        file: files[2],
        operationId: `${operationId}_v2`
      })
    )
    expect(f.hub.respond).toHaveBeenCalledExactlyOnceWith({
      threadId,
      kind: 'status',
      operationId,
      note: 'Updated after review notes (round 2).\n\nPlease review the changes.'
    })
    expect(f.rule().recipients[0]).toMatchObject({ delivery: 'sent', threadId, at: 5 })
    expect(f.rule().recipients[0]!.ownershipTransferredAt).toBeUndefined()
  })

  it('persists sending before the read and replays identical requests after restart', async () => {
    const f = fixture([file('work.md'), file('new.md')])
    const detail = await f.hub.get()
    detail.files = [currentFile('work.md', 'b'.repeat(64))]
    f.hub.get.mockImplementation(async () => {
      expect(f.rule().recipients[0]!.delivery).toBe('sending')
      return detail
    })
    f.hub.respond.mockRejectedValue(new Error('Lost receipt'))
    await expect(deliverSessionFollowUp(f.ctx)).rejects.toMatchObject({ code: 'unconfirmed' })
    const calls = structuredClone(f.hub.returnFile.mock.calls)
    const upload = structuredClone(f.hub.uploadThreadFile.mock.calls[0])
    const entry = structuredClone(f.hub.respond.mock.calls[0])
    await f.ctx.save(normalizeSessionFollowUpRule(JSON.parse(JSON.stringify(f.rule())))!)
    detail.files = [currentFile('work.md', 'd'.repeat(64))]
    f.hub.get.mockClear()
    f.hub.returnFile.mockClear()
    f.hub.uploadThreadFile.mockClear()
    f.hub.respond.mockResolvedValue({ thread_id: threadId })
    await deliverSessionFollowUp(f.ctx)
    expect(f.hub.get).not.toHaveBeenCalled()
    expect(f.hub.returnFile.mock.calls[0]).toEqual(calls[0])
    expect(f.hub.uploadThreadFile.mock.calls[0]).toEqual(upload)
    expect(f.hub.respond.mock.calls.at(-1)).toEqual(entry)
  })

  it('continues after a refused recipient', async () => {
    const f = fixture([])
    f.rule().recipients.push({
      ...f.rule().recipients[0]!,
      employeeId: 'emp_other',
      operationId: 'round_two_other',
      threadId: 'hth_other'
    })
    f.hub.respond
      .mockRejectedValueOnce(new Error('Forbidden'))
      .mockResolvedValueOnce({ thread_id: 'hth_other' })
    f.hub.isRejected.mockReturnValue(true)
    await expect(deliverSessionFollowUp(f.ctx)).rejects.toMatchObject({ code: 'rejected' })
    expect(f.rule().recipients.map((entry) => entry.delivery)).toEqual(['failed', 'sent'])
    expect(f.rule().recipients[0]!.error).toBe('Forbidden')
  })

  it('routes a large revision through thread upload with a round-qualified name', async () => {
    const large = { ...file('video.mp4'), size: 11 * 1024 * 1024 }
    const f = fixture([large])
    const detail = await f.hub.get()
    detail.files = [currentFile(large.name, 'b'.repeat(64))]
    f.hub.get.mockResolvedValue(detail)
    await deliverSessionFollowUp(f.ctx)
    expect(f.hub.returnFile).not.toHaveBeenCalled()
    expect(f.hub.uploadThreadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        file: { ...large, name: 'video (round 2).mp4' },
        operationId: `${operationId}_v0`
      })
    )
  })

  it('keeps the summary name while a re-ask awaits recapture', () => {
    const f = fixture()
    const rule = f.rule()
    rule.summaryFile = 'Summary of the work.md'
    delete rule.capturedAt
    delete rule.files
    delete rule.summaryMarkdown
    const normalized = normalizeSessionFollowUpRule(JSON.parse(JSON.stringify(rule)))!
    expect(normalized.summaryFile).toBe(rule.summaryFile)
    expect(normalized.capturedAt).toBeUndefined()
  })

  it('uses the existing thread for a card-bound re-ask without uploading to the card', async () => {
    const f = fixture()
    f.rule().taskId = 'btk_card1234'
    await deliverSessionFollowUp(f.ctx)
    expect(f.hub.upload).not.toHaveBeenCalled()
    expect(f.hub.send).not.toHaveBeenCalled()
    expect(f.hub.sendCardless).not.toHaveBeenCalled()
    expect(f.hub.respond).toHaveBeenCalledOnce()
  })

  it('normalizes round as an optional positive integer and reask as true-only', () => {
    const f = fixture()
    for (const round of [undefined, 0, -1, 1.5, '2']) {
      const value = {
        ...f.rule(),
        reask: false,
        recipients: [{ ...f.rule().recipients[0], round }]
      }
      const normalized = normalizeSessionFollowUpRule(value)!
      expect(normalized.reask).toBeUndefined()
      expect(normalized.recipients[0]!.round).toBeUndefined()
    }
    expect(normalizeSessionFollowUpRule(f.rule())).toMatchObject({
      reask: true,
      recipients: [{ round: 2 }]
    })
  })
})
