// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { handoffDetail } from '../../../../shared/console-handoff-contract'
import { HandoffDetailView } from './HandoffDetailView'
import { HandoffDecisionBar } from './HandoffDecisionBar'
import { retainPendingHandoff } from './handoff-request-memory'
import { resetHandoffPeopleReads } from '@/components/next-step/use-handoff-people'

const api = vi.hoisted(() => ({
  get: vi.fn(),
  review: vi.fn(),
  respond: vi.fn(),
  read: vi.fn(),
  recipients: vi.fn()
}))
vi.mock('./handoff-client', () => ({
  handoffApi: () => api,
  readHandoffVersionText: api.read,
  downloadHandoffVersion: vi.fn()
}))
vi.mock('./HandoffCommunicationReply', () => ({
  HandoffCommunicationReply: () => <textarea aria-label="Reply text" />
}))
vi.mock('./HandoffTaskAttachDialog', () => ({ HandoffTaskAttachDialog: () => null }))
vi.mock('./HandoffReviewPanel', () => ({ HandoffReviewPanel: () => null }))
vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <p>{content}</p>
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values?.[key] ?? ''))
}))

const detail = handoffDetail.parse({
  thread: {
    id: 'hth_one',
    board_task_id: null,
    author_employee_id: 'emp_author',
    recipient_employee_id: 'emp_recipient',
    title: 'Review work',
    state: 'open',
    action: 'review',
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: ''
  },
  entries: [
    {
      id: 'e1',
      kind: 'handoff',
      body: 'Opening ask',
      created: '',
      references: [
        { kind: 'summary-file', ref: 'summary.md' },
        { kind: 'transcript-file', ref: 'transcript.md' }
      ]
    },
    { id: 'e2', kind: 'reply', body: 'Later reply', created: '' }
  ],
  reviews: [],
  files: ['work.md', 'summary.md', 'transcript.md'].map((name, index) => ({
    id: `hfv_${index}`,
    name,
    path: name,
    current: true,
    available: true,
    sha256: 'a'.repeat(64),
    size: 10,
    version: 1,
    parent_version_id: null
  }))
})

beforeEach(() => {
  vi.resetAllMocks()
  resetHandoffPeopleReads()
  api.recipients.mockResolvedValue({
    ok: true,
    data: {
      employees: [
        { id: 'emp_author', name: 'Sal Baker' },
        { id: 'emp_recipient', name: 'Uma' }
      ]
    }
  })
  localStorage.clear()
  api.get.mockResolvedValue({ ok: true, data: detail })
  api.read.mockResolvedValue('Generated summary')
  api.review.mockResolvedValue({ ok: true, data: detail })
  api.respond.mockResolvedValue({ ok: true, data: detail })
})
afterEach(cleanup)

it('separates the ask, generated context, work files and conversation', async () => {
  render(
    <HandoffDetailView scope="test" threadId="hth_one" viewer="emp_recipient" markRead={false} />
  )
  await screen.findByText('Generated summary')
  const sections = screen.getAllByRole('heading', { level: 2 })
  expect(sections.map((section) => section.textContent)).toEqual([
    'Description',
    'Files',
    'Session transcript',
    'Conversation'
  ])
  expect(sections[0]!.parentElement?.textContent).toContain('Opening ask')
  expect(sections[1]!.parentElement?.textContent).toContain('work.md')
  expect(sections[1]!.parentElement?.textContent).not.toContain('summary.md')
  expect(sections[1]!.parentElement?.textContent).not.toContain('transcript.md')
  expect(sections[3]!.parentElement?.textContent).toContain('Later reply')
  expect(sections[3]!.parentElement?.textContent).not.toContain('Opening ask')
  expect(screen.getByRole('button', { name: 'Looks good, continue' })).toBeTruthy()
})

it('shows an honest empty work-file state and no transcript section', async () => {
  api.get.mockResolvedValue({ ok: true, data: { ...detail, files: [] } })
  render(<HandoffDetailView scope="test" threadId="hth_one" markRead={false} />)
  expect(await screen.findByText('No work files were attached.')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Session transcript' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Looks good, continue' })).toBeNull()
})

it('approves in one click with the exact current versions and a default note', async () => {
  const onChanged = vi.fn()
  render(<HandoffDecisionBar scope="test" detail={detail} onChanged={onChanged} />)
  fireEvent.click(screen.getByRole('button', { name: 'Looks good, continue' }))
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
  expect(api.review).toHaveBeenCalledWith(
    expect.objectContaining({
      decision: 'approve',
      versionIds: ['hfv_0', 'hfv_1', 'hfv_2'],
      note: 'Looks good.'
    })
  )
})

it('only retries a reject completion a pre-removal build already saved, never creates a new one', async () => {
  retainPendingHandoff('test', 'act:hth_one:reject-done', {
    kind: 'respond',
    body: {
      threadId: 'hth_one',
      kind: 'done',
      note: 'Rejected: Wrong scope',
      operationId: 'legacy-reject-done-0001'
    }
  })
  const onChanged = vi.fn()
  render(<HandoffDecisionBar scope="test" detail={detail} onChanged={onChanged} />)
  expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry saved action' }))
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
  expect(api.review).not.toHaveBeenCalled()
  expect(api.respond).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'done',
      note: 'Rejected: Wrong scope',
      operationId: 'legacy-reject-done-0001'
    })
  )
})

it('requires an edits note and sends request_changes without resolving the thread', async () => {
  const onChanged = vi.fn()
  render(<HandoffDecisionBar scope="test" detail={detail} onChanged={onChanged} />)
  fireEvent.click(screen.getByRole('button', { name: 'Needs changes…' }))
  const send = screen.getByRole('button', { name: 'Send decision' }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Update the totals' } })
  fireEvent.click(send)
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
  expect(api.review).toHaveBeenCalledWith(
    expect.objectContaining({ decision: 'request_changes', note: 'Update the totals' })
  )
  expect(api.respond).not.toHaveBeenCalled()
})

it('approves a thread without files with an empty version set', async () => {
  const onChanged = vi.fn()
  render(
    <HandoffDecisionBar scope="test" detail={{ ...detail, files: [] }} onChanged={onChanged} />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Looks good, continue' }))
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
  expect(api.review).toHaveBeenCalledWith(expect.objectContaining({ versionIds: [] }))
})

it('recovers completion from an accepted rejection after a validation refusal cleared its retry record', async () => {
  const onChanged = vi.fn()
  const reviewed = {
    ...detail,
    reviews: [
      {
        id: 'review1',
        decision: 'request_changes' as const,
        current: true,
        version_ids: ['hfv_0', 'hfv_1', 'hfv_2'],
        note: 'Rejected: Wrong scope'
      }
    ]
  }
  render(<HandoffDecisionBar scope="test" detail={reviewed} onChanged={onChanged} />)
  fireEvent.click(screen.getByRole('button', { name: 'Retry saved action' }))
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
  expect(api.review).not.toHaveBeenCalled()
  expect(api.respond).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'done', note: 'Rejected: Wrong scope' })
  )
})

it('shows the hand-off bar and focuses the conversation reply', async () => {
  api.get.mockResolvedValue({
    ok: true,
    data: { ...detail, files: [], thread: { ...detail.thread, action: 'edit' } }
  })
  render(
    <HandoffDetailView scope="test" threadId="hth_one" viewer="emp_recipient" markRead={false} />
  )
  const start = await screen.findByRole('button', { name: 'Start with my AI' })
  expect(start.textContent).toBe('Continue with AI')
  expect(screen.getByRole('button', { name: 'Save files…' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Looks good, continue' })).toBeNull()
  const scroll = vi.fn()
  HTMLElement.prototype.scrollIntoView = scroll
  fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
  expect(screen.getByRole('textbox', { name: 'Reply text' })).toBe(document.activeElement)
  expect(scroll).toHaveBeenCalledOnce()
})

it.each([
  ['resolved', 'emp_recipient'],
  ['open', 'emp_author'],
  ['open', null]
] as const)('hides both action bars for state %s and viewer %s', async (state, viewer) => {
  api.get.mockResolvedValue({ ok: true, data: { ...detail, thread: { ...detail.thread, state } } })
  render(<HandoffDetailView scope="test" threadId="hth_one" viewer={viewer} markRead={false} />)
  await screen.findByText('Generated summary')
  expect(screen.queryByRole('button', { name: 'Looks good, continue' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Start with my AI' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull()
})

it('keeps technical metadata in the collapsed details and filenames in the main sections', async () => {
  api.get.mockResolvedValue({
    ok: true,
    data: {
      ...detail,
      thread: { ...detail.thread, delivery_id: 'delivery_private', board_task_id: 'task_private' }
    }
  })
  const view = render(<HandoffDetailView scope="test" threadId="hth_one" markRead={false} />)
  await screen.findByText('Sal Baker → Uma')
  const drawer = screen.getByText('Version history and details').closest('details')!
  expect(drawer.open).toBe(false)
  expect(drawer.textContent).toContain('Sal Baker (emp_author) → Uma (emp_recipient)')
  expect(drawer.textContent).toContain('delivery_private')
  expect(drawer.textContent).toContain('a'.repeat(64))
  const main = view.container.cloneNode(true) as HTMLElement
  main.querySelectorAll('details').forEach((element) => element.remove())
  for (const token of [
    'emp_author',
    'emp_recipient',
    'hth_one',
    'hfv_',
    'delivery_private',
    'task_private',
    'a'.repeat(64)
  ]) {
    expect(main.textContent).not.toContain(token)
  }
  expect(main.textContent).toContain('work.md')
  expect(main.textContent).toContain('transcript.md')
})
