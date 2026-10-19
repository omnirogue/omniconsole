import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleHandoffClient as client } from './console-handoff-client'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import {
  installHandoffArtifactReviewSend,
  type HandoffArtifactReviewSendHooks
} from './handoff-artifact-review-send'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetchMock = vi.fn<typeof fetch>()
const PAGE = {
  slug: 'launch-plan',
  title: 'Launch plan',
  url: 'https://app.omnisi.ai/a/launch-plan'
}
const thread = {
  id: 'hth_page',
  board_task_id: null,
  author_employee_id: 'emp_sender',
  recipient_employee_id: 'emp_reader',
  title: 'Review: Launch plan',
  state: 'open',
  action: 'review',
  due_at: null,
  parent_thread_id: null,
  delivery_id: null,
  updated: '2026-09-23T10:00:00Z'
}
const sendInput = {
  title: 'Review: Launch plan',
  recipient: 'emp_reader',
  note: `Review the page and decide there: ${PAGE.url}`,
  action: 'review' as const,
  operationId: 'ns_page_review_01',
  attachments: [],
  artifactReview: PAGE
}

function hooks(grant: HandoffArtifactReviewSendHooks['grant']) {
  const value = { grant: vi.fn(grant), sent: vi.fn() }
  installHandoffArtifactReviewSend(value)
  return value
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'test-person-only',
      baseUrl: 'https://console.test',
      principal: 'emp_sender',
      isCurrent: () => true
    }
  } as never)
})
afterEach(() => installHandoffArtifactReviewSend(null))

describe('sending a handoff that carries a page for review', () => {
  it('makes the recipient a reviewer first, then sends the page as a reference', async () => {
    const installed = hooks(async () => ({ ok: true }))
    const order: string[] = []
    installed.grant.mockImplementation(async () => {
      order.push('grant')
      return { ok: true }
    })
    fetchMock.mockImplementationOnce(async () => {
      order.push('send')
      return new Response(JSON.stringify({ thread, entry: { id: 'hent_1' } }), { status: 200 })
    })
    const result = await client.sendCardless(sendInput)
    expect(result).toMatchObject({ ok: true, data: { thread_id: 'hth_page' } })
    expect(order).toEqual(['grant', 'send'])
    expect(installed.grant).toHaveBeenCalledWith({ review: PAGE, reviewer: 'emp_reader' })
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))
    expect(body).toMatchObject({
      title: 'Review: Launch plan',
      action: 'review',
      references: [{ kind: 'artifact-review', ref: 'launch-plan', label: 'Launch plan' }]
    })
    // The page is carried by the reference alone; no extra field reaches the hub.
    expect(body).not.toHaveProperty('artifactReview')
    expect(installed.sent).toHaveBeenCalledWith({
      threadId: 'hth_page',
      review: PAGE,
      recipient: 'emp_reader'
    })
  })

  it('sends nothing when the recipient cannot be made a reviewer', async () => {
    const installed = hooks(async () => ({
      ok: false,
      message: 'Only the person who published it can add a reviewer to it.',
      permanent: true
    }))
    const result = await client.sendCardless(sendInput)
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'artifact_review_grant_failed', status: 422 }
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(installed.sent).not.toHaveBeenCalled()
  })

  it('leaves a passing refusal without a status, so the delivery retries it', async () => {
    hooks(async () => ({ ok: false, message: 'offline', permanent: false }))
    const result = await client.sendCardless(sendInput)
    expect(result.ok ? null : result.error.status).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a page review on a desktop without the page service', async () => {
    const result = await client.sendCardless(sendInput)
    expect(result).toMatchObject({ ok: false, error: { code: 'artifact_review_unavailable' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends an ordinary handoff with no grant and no page reference', async () => {
    const installed = hooks(async () => ({ ok: true }))
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ thread, entry: { id: 'hent_1' } }), { status: 200 })
    )
    const { artifactReview: _page, ...plain } = sendInput
    await client.sendCardless(plain)
    expect(installed.grant).not.toHaveBeenCalled()
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).not.toHaveProperty('references')
  })
})
