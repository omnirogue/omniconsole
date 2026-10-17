// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionProjectThread } from '@/lib/session-project-threads'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionProjectRows } from './use-session-project-rows'

const mocks = vi.hoisted(() => ({
  inline: true,
  sendReply: vi.fn(),
  toast: vi.fn()
}))
vi.mock('@/components/sidebar/session-folders/session-queue-state', () => ({
  cancelQueuedSession: vi.fn(),
  useQueuedSessionRowKeys: () => new Set<string>()
}))
vi.mock('@/components/sidebar/session-folders/SessionSidebarTreeRowItem', () => ({
  SessionSidebarTreeRowItem: ({ row }: { row: { session: SidebarSession } }) => (
    <div>{row.session.label}</div>
  )
}))
vi.mock('@/components/needs-you/NeedsYouQuestionRow', () => ({
  NeedsYouQuestionRow: ({ paneKey }: { paneKey: string }) => <li data-question={paneKey} />
}))
vi.mock('@/components/needs-you/use-session-question-rows', () => ({
  useSessionQuestionsInline: () => mocks.inline
}))
vi.mock('./use-session-project-review', () => ({
  useSessionProjectOutputs: () => () => []
}))
vi.mock('@/lib/session-reply-send', async () => ({
  ...(await vi.importActual('@/lib/session-reply-send')),
  sendSessionReply: mocks.sendReply
}))
vi.mock('sonner', () => ({ toast: { success: mocks.toast } }))

import { SessionProjectThreadRows } from './SessionProjectThreadList'

const PANE = 'tab-1:11111111-2222-4333-8444-555555555555'

function thread(overrides: Partial<SidebarSession> = {}): SessionProjectThread {
  return {
    row: {
      session: {
        rowKey: 'row-1',
        sessionKey: null,
        worktreeId: 'wt-1',
        hostId: 'local',
        tabId: 'tab-1',
        paneKey: PANE,
        kind: 'terminal',
        label: 'Pick the launch price',
        workspaceLabel: 'Ads',
        agent: 'claude',
        unavailable: false,
        folderKeyMigration: null,
        ...overrides
      },
      folderId: 'folder',
      attention: null,
      state: 'blocked',
      waitingUntil: null
    },
    status: 'needsYou',
    isCoordinator: false,
    agent: 'claude',
    lastActivityAt: null
  }
}

const data = {
  chainsByRowKey: new Map(),
  now: 0
} as unknown as SessionProjectRows

beforeEach(() => {
  mocks.inline = true
  mocks.sendReply.mockReset()
  mocks.toast.mockReset()
})
afterEach(cleanup)

it('shows the thread’s pending question under its row', () => {
  const { container } = render(<SessionProjectThreadRows threads={[thread()]} data={data} />)
  expect(container.querySelector(`[data-question="${PANE}"]`)).not.toBeNull()
})

it('leaves questions to the terminal when inline answers are off', () => {
  mocks.inline = false
  const { container } = render(<SessionProjectThreadRows threads={[thread()]} data={data} />)
  expect(container.querySelector('[data-question]')).toBeNull()
})

it('sends a follow-up from the row and closes the field', async () => {
  mocks.sendReply.mockResolvedValue(undefined)
  render(<SessionProjectThreadRows threads={[thread()]} data={data} />)
  fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Reply to Pick the launch price' }), {
    target: { value: '  Use $49  ' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
  expect(mocks.sendReply).toHaveBeenCalledWith(
    expect.objectContaining({ rowKey: 'row-1' }),
    'Use $49'
  )
  expect(mocks.toast).toHaveBeenCalledWith('Sent to Pick the launch price.')
})

it('keeps the draft and says why when the reply was refused', async () => {
  mocks.sendReply.mockRejectedValue(new Error('The selected agent needs permission.'))
  render(<SessionProjectThreadRows threads={[thread()]} data={data} />)
  fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
  const field = screen.getByRole('textbox', {
    name: 'Reply to Pick the launch price'
  })
  fireEvent.change(field, { target: { value: 'go' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'The selected agent needs permission.'
  )
  expect(field).toHaveProperty('value', 'go')
})

it('offers no reply to a thread whose terminal is gone', () => {
  render(<SessionProjectThreadRows threads={[thread({ unavailable: true })]} data={data} />)
  expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull()
})

it('says which task started a worker, naming the chat when it sent it', () => {
  render(
    <SessionProjectThreadRows
      threads={[
        { ...thread(), origin: { task: 'Fix checkout', fromChat: true } },
        { ...thread({ rowKey: 'row-2' }), origin: { task: 'Write tests', fromChat: false } }
      ]}
      data={data}
    />
  )
  expect(screen.getByText('From the chat: Fix checkout')).not.toBeNull()
  expect(screen.getByText('For: Write tests')).not.toBeNull()
})
