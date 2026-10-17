import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ExactHandoffFile } from '../../../shared/console-handoff-contract'
import type { SessionFollowUpRule } from '../../../shared/session-follow-up-rule'
import { partitionCardlessAttachments } from './session-follow-up-cardless-delivery'
import {
  captureFollowUpFiles,
  deliverSessionFollowUp,
  FollowUpException,
  resolveFollowUpFiles,
  type FollowUpDeliveryContext,
  type FollowUpHostIo
} from './session-follow-up-delivery'

class Refused extends Error {}

function exact(name: string, text: string): ExactHandoffFile {
  const bytes = Buffer.from(text)
  return {
    name,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentBase64: bytes.toString('base64')
  }
}

const report = exact('report.md', 'final report')
const summary = exact('draft-final-summary.md', '# summary')

function capturedRule(extra: Partial<SessionFollowUpRule> = {}): SessionFollowUpRule {
  return {
    revision: 1,
    taskId: 'btk_abcd1234',
    taskTitle: 'Webinar intro',
    sessionLabel: 'Draft',
    recipients: [
      { employeeId: 'emp_iris', name: 'Iris', operationId: 'fu_iris_op', delivery: 'pending' },
      { employeeId: 'emp_gamma', name: 'Gamma', operationId: 'fu_gamma_op', delivery: 'pending' }
    ],
    action: 'review',
    deliverables: { kind: 'files', paths: ['/w/out/report.md'] },
    includeSummary: true,
    note: 'Please review',
    savedAt: 1,
    capturedAt: 2,
    files: [
      {
        sourcePath: '/w/out/report.md',
        name: report.name,
        sha256: report.sha256,
        size: report.size
      },
      { sourcePath: null, name: summary.name, sha256: summary.sha256, size: summary.size }
    ],
    summaryMarkdown: '# summary',
    ...extra
  }
}

function harness(rule: SessionFollowUpRule) {
  const state = { saved: rule, cancelled: false }
  const events: string[] = []
  const ctx: FollowUpDeliveryContext = {
    current: () => (state.cancelled ? null : state.saved),
    save: vi.fn(async (next: SessionFollowUpRule) => {
      state.saved = next
      events.push(
        `save ${next.recipients.map((person) => `${person.employeeId}=${person.delivery}`).join(' ')}`
      )
    }),
    hub: {
      upload: vi.fn(async (_taskId: string, file: ExactHandoffFile) => {
        events.push(`upload ${file.name}`)
        return { path: `handoffs/${file.name}`, sha256: file.sha256 }
      }),
      send: vi.fn(async (input) => {
        events.push(`send ${input.recipient} ${input.operationId}`)
        return { thread_id: `hth_${input.recipient.slice(4)}` }
      }),
      sendCardless: vi.fn(async (input) => {
        events.push(
          `sendCardless ${input.recipient} ${input.operationId} [${input.attachments.map((file) => file.name).join(',')}]`
        )
        return { thread_id: `hth_${input.recipient.slice(4)}` }
      }),
      uploadThreadFile: vi.fn(async (input) => {
        events.push(`uploadThreadFile ${input.threadId} ${input.file.name} ${input.operationId}`)
        return { thread_id: input.threadId }
      }),
      isRejected: (error: unknown) => error instanceof Refused
    },
    bytes: vi.fn(async (pin) => (pin.name === report.name ? report : summary)),
    now: () => 1000,
    sleep: vi.fn(async () => undefined)
  }
  return { ctx, state, events }
}

describe('follow-up delivery', () => {
  it('refuses folder archive name collisions after exact capture and with generated history', async () => {
    const folder = exact('report.tar.gz', 'archive')
    const file = exact('report.tar.gz', 'other bytes')
    const io: FollowUpHostIo = {
      exists: async () => true,
      size: async () => 0,
      readExact: async (path) => (path.endsWith('/report') ? folder : file)
    }
    await expect(
      captureFollowUpFiles(['/w/report', '/w/report.tar.gz'], null, io)
    ).rejects.toMatchObject({ code: 'duplicate-names' })
    await expect(captureFollowUpFiles(['/w/report'], null, io, file)).rejects.toMatchObject({
      code: 'duplicate-names'
    })
  })
  it('saves each marker before its effect and sends each person exactly once', async () => {
    const { ctx, state, events } = harness(capturedRule())
    await expect(deliverSessionFollowUp(ctx)).resolves.toBe('delivered')
    expect(events).toEqual([
      'upload report.md',
      'save emp_iris=pending emp_gamma=pending',
      'upload draft-final-summary.md',
      'save emp_iris=pending emp_gamma=pending',
      'save emp_iris=sending emp_gamma=pending',
      'send emp_iris fu_iris_op',
      'save emp_iris=sent emp_gamma=pending',
      'save emp_iris=sent emp_gamma=sending',
      'send emp_gamma fu_gamma_op',
      'save emp_iris=sent emp_gamma=sent'
    ])
    expect(state.saved.recipients.map((person) => person.threadId)).toEqual([
      'hth_iris',
      'hth_gamma'
    ])
    expect(ctx.hub.send).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'btk_abcd1234',
        action: 'review',
        fileVersions: [
          { path: 'handoffs/report.md', sha256: report.sha256 },
          { path: 'handoffs/draft-final-summary.md', sha256: summary.sha256 }
        ]
      })
    )
  })

  it('replays an uncertain answer with the same operation id', async () => {
    const { ctx } = harness(capturedRule({ recipients: [capturedRule().recipients[0]!] }))
    vi.mocked(ctx.hub.send)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ thread_id: 'hth_iris' })
    await expect(deliverSessionFollowUp(ctx)).resolves.toBe('delivered')
    expect(vi.mocked(ctx.hub.send).mock.calls.map(([input]) => input.operationId)).toEqual([
      'fu_iris_op',
      'fu_iris_op'
    ])
    expect(ctx.sleep).toHaveBeenCalledWith(2_000)
  })

  it('records ownership transfer only after the real delivery receipt', async () => {
    const { ctx, state } = harness(
      capturedRule({
        disposition: 'ownership-transfer',
        recipients: [capturedRule().recipients[0]!]
      })
    )
    await expect(deliverSessionFollowUp(ctx)).resolves.toBe('delivered')
    expect(state.saved.recipients[0]).toMatchObject({
      delivery: 'sent',
      threadId: 'hth_iris',
      ownershipTransferredAt: 1000
    })
  })

  it('keeps an unconfirmed person replayable and never resends an acknowledged one', async () => {
    const { ctx, state } = harness(capturedRule())
    vi.mocked(ctx.hub.send).mockImplementation(async (input) => {
      if (input.recipient === 'emp_gamma') {
        throw new Error('socket hang up')
      }
      return { thread_id: 'hth_iris' }
    })
    await expect(deliverSessionFollowUp(ctx)).rejects.toMatchObject({
      code: 'unconfirmed',
      subject: 'Gamma'
    })
    expect(state.saved.recipients.map((person) => person.delivery)).toEqual(['sent', 'sending'])
    expect(
      vi.mocked(ctx.hub.send).mock.calls.filter(([input]) => input.recipient === 'emp_gamma')
    ).toHaveLength(3)

    vi.mocked(ctx.hub.send).mockClear()
    vi.mocked(ctx.hub.send).mockResolvedValue({ thread_id: 'hth_gamma' })
    await expect(deliverSessionFollowUp(ctx)).resolves.toBe('delivered')
    expect(
      vi.mocked(ctx.hub.send).mock.calls.map(([input]) => [input.recipient, input.operationId])
    ).toEqual([['emp_gamma', 'fu_gamma_op']])
    expect(ctx.hub.upload).toHaveBeenCalledTimes(2)
  })

  it('turns a refusal into an exception while the other person is still delivered', async () => {
    const { ctx, state } = harness(capturedRule())
    vi.mocked(ctx.hub.send).mockImplementation(async (input) => {
      if (input.recipient === 'emp_iris') {
        throw new Refused('HTTP 403 forbidden')
      }
      return { thread_id: 'hth_gamma' }
    })
    await expect(deliverSessionFollowUp(ctx)).rejects.toMatchObject({
      code: 'rejected',
      subject: 'Iris',
      detail: 'HTTP 403 forbidden'
    })
    expect(state.saved.recipients.map((person) => [person.delivery, person.threadId])).toEqual([
      ['failed', undefined],
      ['sent', 'hth_gamma']
    ])
    // A refusal is an answer: it is not replayed.
    expect(
      vi.mocked(ctx.hub.send).mock.calls.filter(([input]) => input.recipient === 'emp_iris')
    ).toHaveLength(1)
  })

  it('sends nothing when a cancel lands while the marker is being saved', async () => {
    const { ctx, state } = harness(capturedRule())
    vi.mocked(ctx.save).mockImplementation(async (next) => {
      state.saved = next
      if (next.recipients.some((person) => person.delivery === 'sending')) {
        state.cancelled = true
      }
    })
    await expect(deliverSessionFollowUp(ctx)).resolves.toBe('stopped')
    expect(ctx.hub.send).not.toHaveBeenCalled()
    expect(state.saved.recipients.map((person) => person.delivery)).toEqual(['pending', 'pending'])
  })

  it('resumes after a restart from the persisted marks: no re-upload, one replay', async () => {
    const rule = capturedRule({
      files: capturedRule().files!.map((pin) => ({ ...pin, taskPath: `handoffs/${pin.name}` })),
      recipients: [
        { ...capturedRule().recipients[0]!, delivery: 'sent', threadId: 'hth_iris' },
        { ...capturedRule().recipients[1]!, delivery: 'sending' }
      ]
    })
    const { ctx } = harness(rule)
    await expect(deliverSessionFollowUp(ctx)).resolves.toBe('delivered')
    expect(ctx.hub.upload).not.toHaveBeenCalled()
    expect(vi.mocked(ctx.hub.send).mock.calls.map(([input]) => input.operationId)).toEqual([
      'fu_gamma_op'
    ])
  })

  it('stops before any request when the captured bytes changed', async () => {
    const { ctx } = harness(capturedRule())
    vi.mocked(ctx.bytes).mockResolvedValue(exact('report.md', 'edited later'))
    await expect(deliverSessionFollowUp(ctx)).rejects.toMatchObject({
      code: 'files-changed',
      subject: 'report.md'
    })
    expect(ctx.hub.upload).not.toHaveBeenCalled()
    expect(ctx.hub.send).not.toHaveBeenCalled()
  })
})

function hostIo(files: Record<string, ExactHandoffFile | number>): FollowUpHostIo {
  return {
    exists: vi.fn(async (path: string) => path in files),
    size: vi.fn(async (path: string) => {
      const entry = files[path]
      return typeof entry === 'number' ? entry : (entry?.size ?? 0)
    }),
    readExact: vi.fn(async (path: string) => {
      const entry = files[path]
      if (!entry || typeof entry === 'number') {
        throw new Error(`unreadable ${path}`)
      }
      return entry
    })
  }
}

describe('card-less follow-up delivery', () => {
  it('sends each person a thread of its own with the exact bytes attached, never a card upload', async () => {
    const { ctx, state, events } = harness(capturedRule({ taskId: null }))
    await expect(deliverSessionFollowUp(ctx)).resolves.toBe('delivered')
    expect(ctx.hub.upload).not.toHaveBeenCalled()
    expect(ctx.hub.send).not.toHaveBeenCalled()
    expect(events).toEqual([
      'save emp_iris=sending emp_gamma=pending',
      'sendCardless emp_iris fu_iris_op [report.md,draft-final-summary.md]',
      'save emp_iris=sent emp_gamma=pending',
      'save emp_iris=sent emp_gamma=sending',
      'sendCardless emp_gamma fu_gamma_op [report.md,draft-final-summary.md]',
      'save emp_iris=sent emp_gamma=sent'
    ])
    expect(state.saved.recipients.map((person) => person.threadId)).toEqual([
      'hth_iris',
      'hth_gamma'
    ])
    expect(ctx.hub.sendCardless).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Webinar intro',
        action: 'review',
        note: 'Please review',
        attachments: [report, summary]
      })
    )
  })

  it('stops before any request when a captured file changed', async () => {
    const { ctx } = harness(capturedRule({ taskId: null }))
    vi.mocked(ctx.bytes).mockResolvedValue({ ...report, sha256: 'f'.repeat(64) })
    await expect(deliverSessionFollowUp(ctx)).rejects.toMatchObject({ code: 'files-changed' })
    expect(ctx.hub.sendCardless).not.toHaveBeenCalled()
  })

  it('adds the files the create could not carry under keys derived from the same operation', () => {
    const big = { ...report, contentBase64: 'x'.repeat(10) }
    const small = { ...summary, contentBase64: 'y'.repeat(4) }
    expect(partitionCardlessAttachments([big, small, big], 12)).toEqual({
      withCreate: [big],
      afterwards: [small, big]
    })
    expect(partitionCardlessAttachments([small, small], 12)).toEqual({
      withCreate: [small, small],
      afterwards: []
    })
  })
})

describe('follow-up capture', () => {
  const manifestPath = '/w/.omni/runs/c/s/manifest.md'

  it('keeps waiting while any selected file or the manifest is missing', async () => {
    const files = capturedRule({ deliverables: { kind: 'files', paths: ['/w/a.md', '/w/b.md'] } })
    expect(await resolveFollowUpFiles(files, '/w', hostIo({ '/w/a.md': report }))).toEqual({
      paths: ['/w/a.md', '/w/b.md'],
      missing: ['b.md']
    })
    const manifest = capturedRule({ deliverables: { kind: 'manifest', manifestPath } })
    expect(await resolveFollowUpFiles(manifest, '/w', hostIo({}))).toEqual({
      paths: [],
      missing: ['manifest.md']
    })
    expect(
      await resolveFollowUpFiles(
        manifest,
        '/w',
        hostIo({ [manifestPath]: exact('manifest.md', '# none') })
      )
    ).toEqual({ paths: [], missing: ['manifest.md'] })
    const listed = hostIo({
      [manifestPath]: exact('manifest.md', '- report.md\n- deck.pptx'),
      '/w/.omni/runs/c/s/report.md': report
    })
    expect(await resolveFollowUpFiles(manifest, '/w', listed)).toEqual({
      paths: ['/w/.omni/runs/c/s/report.md', '/w/.omni/runs/c/s/deck.pptx'],
      missing: ['deck.pptx']
    })
  })

  it('refuses a manifest that lists a file outside the workspace', async () => {
    const manifest = capturedRule({ deliverables: { kind: 'manifest', manifestPath } })
    const io = hostIo({ [manifestPath]: exact('manifest.md', '- /etc/leak.txt') })
    await expect(resolveFollowUpFiles(manifest, '/w', io)).rejects.toMatchObject({
      code: 'outside-workspace',
      subject: '/etc/leak.txt'
    })
  })

  it('captures exact bytes once and refuses oversize, duplicate or too many files', async () => {
    const io = hostIo({ '/w/report.md': report, '/w/big.mov': 11 * 1024 * 1024 })
    const capture = await captureFollowUpFiles(['/w/report.md'], summary, io)
    expect(capture.pins).toEqual([
      { sourcePath: '/w/report.md', name: 'report.md', sha256: report.sha256, size: report.size },
      { sourcePath: null, name: summary.name, sha256: summary.sha256, size: summary.size }
    ])
    expect(capture.bytes.get('report.md')).toBe(report)
    await expect(captureFollowUpFiles(['/w/big.mov'], null, io)).rejects.toBeInstanceOf(
      FollowUpException
    )
    await expect(captureFollowUpFiles(['/w/big.mov'], null, io)).rejects.toMatchObject({
      code: 'file-too-large',
      subject: 'big.mov'
    })
    await expect(
      captureFollowUpFiles(['/w/report.md', '/w/other/report.md'], null, io)
    ).rejects.toMatchObject({ code: 'duplicate-names', subject: 'report.md' })
    const many = Array.from({ length: 33 }, (_, index) => `/w/f${index}.md`)
    await expect(captureFollowUpFiles(many, null, io)).rejects.toMatchObject({
      code: 'too-many-files'
    })
    expect(io.readExact).toHaveBeenCalledTimes(1)
  })
})
