import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExactHandoffFile } from '../../shared/console-handoff-contract'
import { handoffDispositionOf } from '../../shared/console-handoff-disposition-reference'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import {
  deliverSessionFollowUp,
  type FollowUpDeliveryContext
} from '../../shared/session-follow-up-delivery'
import type { SessionFollowUpRule } from '../../shared/session-follow-up-rule'
import { consoleHandoffClient as client } from './console-handoff-client'
import {
  hubHandoffRequestShapes,
  hubHandoffVerbForPath,
  type HubHandoffVerb
} from './console-handoff-hub-request-shape.test-fixture'
import { captureConsoleWorkflowPerson } from './console-workflow-person'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

const RECIPIENT = 'emp_sal_qa_test'
const TASK = 'btk_card1234'
const THREAD = 'hth_thread1234'
const OPERATION = '71fe5667-eb55-4ec1-b726-57f9076de755'
type Relayed = { verb: HubHandoffVerb | null; path: string; body: Record<string, unknown> }
let relayed: Relayed[] = []

function exactFile(name: string, bytes: Buffer): ExactHandoffFile {
  return {
    name,
    contentBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length
  }
}

/** Answers as the hub does, so the client's own receipt checks pass and delivery runs to its end. */
const relay: typeof fetch = async (input, init) => {
  const path = new URL(String(input)).pathname
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
  relayed.push({ verb: hubHandoffVerbForPath(path), path, body })
  return new Response(
    JSON.stringify({
      thread: {
        id: THREAD,
        board_task_id: path.includes('/team/tasks/') ? TASK : (body.board_task_id ?? null),
        author_employee_id: 'emp_author',
        recipient_employee_id: body.recipient_employee_id ?? RECIPIENT,
        title: 'Result',
        state: 'open',
        action: body.action ?? null,
        communication_type: body.communication_type ?? null,
        due_at: null,
        parent_thread_id: null,
        delivery_id: null,
        updated: '2026-09-18T13:46:00Z'
      },
      files: [],
      reviews: [],
      entries: [],
      entry: { id: 'entry_1' }
    })
  )
}

function data<T>(result: ConsoleWorkflowResult<T>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`)
  }
  return result.data
}

function expectEveryRequestAccepted(): void {
  expect(relayed.length).toBeGreaterThan(0)
  for (const request of relayed) {
    expect(request.verb, `no hub shape is known for ${request.path}`).not.toBeNull()
    const verdict = hubHandoffRequestShapes[request.verb!].safeParse(request.body)
    expect(
      verdict.success ? [] : verdict.error.issues,
      `${request.verb} would be refused by the relay or the hub`
    ).toEqual([])
  }
}

async function deliver(start: SessionFollowUpRule, files: ExactHandoffFile[]): Promise<void> {
  let rule = start
  const ctx: FollowUpDeliveryContext = {
    current: () => rule,
    save: async (value) => {
      rule = value
    },
    hub: {
      get: async (input) => ({
        ...data(await client.get(input)),
        files: files.map((file) => ({
          ...file,
          id: 'hfv_original',
          path: file.name,
          sha256: 'b'.repeat(64),
          version: 1,
          parent_version_id: null,
          current: true,
          available: true
        }))
      }),
      respond: async (input) => data(await client.respond(input)),
      returnFile: async (input) => data(await client.returnFile(input)),
      upload: vi.fn(),
      send: async (input) => data(await client.send(input)),
      sendCardless: async (input) => data(await client.sendCardless(input)),
      uploadThreadFile: async (input) => data(await client.uploadThreadFile(input)),
      isRejected: () => true
    },
    bytes: async (pin) => files.find((file) => file.name === pin.name)!,
    now: () => 3,
    sleep: vi.fn()
  }
  expect(await deliverSessionFollowUp(ctx)).toBe('delivered')
  expect(rule.recipients.map((recipient) => recipient.delivery)).toEqual(['sent'])
  expect(rule.recipients[0]!.threadId).toBe(THREAD)
}

function ruleFor(
  disposition: 'ownership-transfer' | 'feedback',
  taskId: string | null,
  files: ExactHandoffFile[]
): SessionFollowUpRule {
  return {
    revision: 1,
    taskId,
    taskTitle: 'Result',
    sessionLabel: 'Source',
    disposition,
    recipients: [
      {
        employeeId: RECIPIENT,
        name: 'Sal Test Blake Test',
        operationId: OPERATION,
        delivery: 'pending'
      }
    ],
    action: disposition === 'feedback' ? 'review' : 'edit',
    communicationType: 'request',
    deliverables: { kind: 'files', paths: [] },
    includeSummary: true,
    note: 'Read the result.',
    // Why: toISOString() always carries milliseconds, which the relay's due_at pattern refuses.
    dueAt: '2026-09-19T17:00:00.000Z',
    savedAt: 1,
    capturedAt: 2,
    files: files.map((file) => ({
      sourcePath: null,
      name: file.name,
      sha256: file.sha256,
      size: file.size,
      ...(taskId ? { taskPath: `handoffs/${file.name}` } : {})
    }))
  }
}

beforeEach(() => {
  relayed = []
  vi.stubGlobal('fetch', vi.fn(relay))
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'test-person-only',
      baseUrl: 'https://console.test',
      principal: 'test-person',
      isCurrent: () => true
    }
  } as never)
})

describe('a saved follow-up is delivered in the shape the relay and the hub accept', () => {
  it.each(['ownership-transfer', 'feedback'] as const)('card-bound %s', async (disposition) => {
    const summary = exactFile(`session-${OPERATION}.md`, Buffer.from('# Summary'))
    await deliver(ruleFor(disposition, TASK, [summary]), [summary])
    expectEveryRequestAccepted()
    expect(relayed.map((request) => request.verb)).toEqual(['send'])
    const [{ body }] = relayed
    expect(body.references).toEqual([
      { kind: 'disposition', ref: disposition },
      { kind: 'summary-file', ref: summary.name }
    ])
    expect(body.file_versions).toEqual([
      { path: `handoffs/${summary.name}`, sha256: summary.sha256 }
    ])
    expect(body.due_at).toBe('2026-09-19T17:00:00Z')
    expect(handoffDispositionOf([{ references: body.references as unknown[] }])).toBe(disposition)
  })

  it.each(['ownership-transfer', 'feedback'] as const)(
    'card-less %s with its files',
    async (disposition) => {
      const summary = exactFile(`session-${OPERATION}.md`, Buffer.from('# Summary'))
      const work = exactFile('report.md', Buffer.from('# Report'))
      await deliver(ruleFor(disposition, null, [work, summary]), [work, summary])
      expectEveryRequestAccepted()
      expect(relayed.map((request) => request.verb)).toEqual(['sendCardless'])
      const [{ body }] = relayed
      expect(body.references).toEqual([
        { kind: 'disposition', ref: disposition },
        { kind: 'summary-file', ref: summary.name }
      ])
      expect(body.attachments).toEqual([
        { filename: work.name, content_base64: work.contentBase64 },
        { filename: summary.name, content_base64: summary.contentBase64 }
      ])
      expect(handoffDispositionOf([{ references: body.references as unknown[] }])).toBe(disposition)
    }
  )

  it('card-less files beyond one request follow on the thread under accepted keys', async () => {
    const first = exactFile('first.bin', Buffer.alloc(5 * 1024 * 1024, 1))
    const second = exactFile('second.bin', Buffer.alloc(5 * 1024 * 1024, 2))
    await deliver(ruleFor('feedback', null, [first, second]), [first, second])
    expectEveryRequestAccepted()
    expect(relayed.map((request) => request.verb)).toEqual(['sendCardless', 'uploadThreadFile'])
    expect(relayed[1]!.body.idempotency_key).toBe(`${OPERATION}_f1`)
  })

  it('re-ask versions and status use accepted wire bodies without opening references', async () => {
    const summary = exactFile('Summary.md', Buffer.from('# Revised summary'))
    const rule = ruleFor('feedback', null, [summary])
    rule.reask = true
    rule.summaryFile = summary.name
    Object.assign(rule.recipients[0]!, { threadId: THREAD, round: 2 })
    await deliver(rule, [summary])
    relayed = relayed.filter((request) => !request.path.endsWith(`/handoffs/${THREAD}`))
    expectEveryRequestAccepted()
    expect(relayed.map((request) => request.verb)).toEqual(['returnFile', 'respond'])
    expect(relayed[0]!.body).toMatchObject({
      filename: summary.name,
      base_version_id: 'hfv_original',
      idempotency_key: `${OPERATION}_v0`
    })
    expect(relayed[1]!.body).toEqual({
      kind: 'status',
      body: 'Updated after review notes (round 2).',
      idempotency_key: OPERATION
    })
  })

  it('refuses the object-shaped references that failed both people on 2026-09-18', () => {
    const accepted = {
      recipient_employee_id: RECIPIENT,
      title: 'Result',
      body: 'Read the result.',
      idempotency_key: OPERATION
    }
    for (const verb of ['send', 'sendCardless'] as const) {
      expect(hubHandoffRequestShapes[verb].safeParse(accepted).success).toBe(true)
      expect(
        hubHandoffRequestShapes[verb].safeParse({
          ...accepted,
          references: { disposition: 'feedback' }
        }).success
      ).toBe(false)
    }
  })
})

describe('every other handoff write is sent in the shape the relay and the hub accept', () => {
  const file = exactFile('reply.md', Buffer.from('# Reply'))
  const note = 'Here is the work.'

  it('forward carries an action and no references', async () => {
    data(
      await client.forward({
        threadId: THREAD,
        recipient: RECIPIENT,
        action: 'review',
        communicationType: 'request',
        note,
        fileVersions: [{ path: 'handoffs/reply.md', sha256: file.sha256 }],
        dueAt: '2026-09-19T17:00:00.000+02:00',
        operationId: OPERATION
      })
    )
    expectEveryRequestAccepted()
    expect(relayed[0]!.body).not.toHaveProperty('references')
    expect(relayed[0]!.body.due_at).toBe('2026-09-19T17:00:00+02:00')
  })

  it('forward is refused here, not at the hub, when it names a disposition or no action', async () => {
    const forward = { threadId: THREAD, recipient: RECIPIENT, note, fileVersions: [] }
    for (const args of [
      { ...forward, operationId: OPERATION },
      { ...forward, operationId: OPERATION, action: 'review', disposition: 'feedback' }
    ]) {
      expect(await client.forward(args as never)).toMatchObject({ ok: false })
    }
    expect(relayed).toEqual([])
  })

  it('reply, done, review, thread upload, returned file and bind', async () => {
    data(await client.respond({ threadId: THREAD, kind: 'reply', note, operationId: OPERATION }))
    data(await client.respond({ threadId: THREAD, kind: 'done', note, operationId: OPERATION }))
    data(
      await client.review({
        threadId: THREAD,
        decision: 'request_changes',
        versionIds: ['hfv_version1234'],
        note,
        operationId: OPERATION
      })
    )
    data(await client.uploadThreadFile({ threadId: THREAD, file, note, operationId: OPERATION }))
    data(
      await client.returnFile({
        threadId: THREAD,
        baseVersionId: 'hfv_version1234',
        file,
        note,
        operationId: OPERATION
      })
    )
    data(await client.bindThread({ threadId: THREAD, taskId: TASK }))
    expectEveryRequestAccepted()
    expect(relayed.map((request) => request.verb)).toEqual([
      'respond',
      'respond',
      'review',
      'uploadThreadFile',
      'returnFile',
      'bindThread'
    ])
  })
})
