// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { AttachToTaskDialog } from './AttachToTaskDialog'
const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  scope: 'sal',
  connected: true,
  more: vi.fn(),
  warning: vi.fn(),
  query: ''
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (state: object) => unknown) => select({}), {
    getState: () => ({})
  })
}))
vi.mock('@/lib/console-account-scope', () => ({ selectConsoleAccountScope: () => mocks.scope }))
vi.mock('@/lib/attach-jira-session', () => ({ attachSessionToJira: mocks.attach }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: mocks.warning } }))
vi.mock('./use-jira-attach-tasks', () => ({
  useJiraAttachTasks: (_active: boolean, _scope: string, query: string) => {
    mocks.query = query
    return {
      config: {
        enabled: true,
        projects: [{ key: 'APU', name: 'APU' }],
        connection: { connected: mocks.connected }
      },
      issues: mocks.connected ? [task] : [],
      cursor: 'next',
      loading: false,
      error: '',
      loadMore: mocks.more,
      retry: vi.fn()
    }
  }
}))
const task = {
  work_ref: {
    provider: 'jira',
    cloud_id: 'bb6f9191-a21a-4857-b965-32de82dce68b',
    issue_id: '10001',
    issue_key: 'APU-1',
    project_key: 'APU'
  },
  summary: 'Existing commitment',
  division: { name: 'Operations' },
  status: { name: 'Ready' }
}
const session = {
  hostId: 'local',
  sessionKey: 'session',
  paneKey: 'tab:leaf',
  kind: 'terminal',
  label: 'Work'
} as SidebarSession
beforeEach(() => {
  mocks.scope = 'sal'
  mocks.connected = true
  mocks.attach.mockReset()
  mocks.more.mockClear()
  mocks.warning.mockClear()
})
afterEach(cleanup)
it('selects an existing Jira reference and exposes paged search', async () => {
  mocks.attach.mockResolvedValue({})
  const close = vi.fn()
  render(<AttachToTaskDialog session={session} onOpenChange={close} />)
  fireEvent.change(screen.getByLabelText('Find a Jira task'), { target: { value: 'APU-1' } })
  expect(mocks.query).toBe('APU-1')
  fireEvent.click(screen.getByRole('button', { name: 'Load more tasks' }))
  expect(mocks.more).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: /APU-1 · Existing commitment/ }))
  await waitFor(() => expect(close).toHaveBeenCalledWith(false))
  expect(mocks.attach).toHaveBeenCalledWith(session, task)
})
it('keeps a refused attachment open with the reason', async () => {
  mocks.attach.mockRejectedValue(new Error('Reload the changed summary'))
  const close = vi.fn()
  render(<AttachToTaskDialog session={session} onOpenChange={close} />)
  fireEvent.click(screen.getByRole('button', { name: /APU-1 · Existing commitment/ }))
  expect((await screen.findByRole('alert')).textContent).toContain('Reload the changed summary')
  expect(close).not.toHaveBeenCalled()
})
it('does not publish a late result after the source account changed', async () => {
  let finish!: (value: object) => void
  mocks.attach.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const close = vi.fn()
  const { rerender } = render(<AttachToTaskDialog session={session} onOpenChange={close} />)
  fireEvent.click(screen.getByRole('button', { name: /APU-1 · Existing commitment/ }))
  mocks.scope = 'uma'
  rerender(<AttachToTaskDialog session={session} onOpenChange={close} />)
  finish({})
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: /APU-1 · Existing commitment/ }).hasAttribute('disabled')
    ).toBe(false)
  )
  expect(close).not.toHaveBeenCalled()
})
it('explains personal connection setup instead of offering legacy tasks', () => {
  mocks.connected = false
  render(<AttachToTaskDialog session={session} onOpenChange={vi.fn()} />)
  expect(screen.getByRole('status').textContent).toContain('Connect your own Jira account')
  expect(screen.queryByRole('button', { name: /Existing commitment/ })).toBeNull()
})
it('opens with no session for a caller that saves the pick itself', async () => {
  const select = vi.fn().mockResolvedValue(true)
  const close = vi.fn()
  render(<AttachToTaskDialog session={null} open onOpenChange={close} onSelect={select} />)
  fireEvent.click(screen.getByRole('button', { name: /APU-1 · Existing commitment/ }))
  await waitFor(() => expect(close).toHaveBeenCalledWith(false))
  expect(select).toHaveBeenCalledWith(task)
  expect(mocks.attach).not.toHaveBeenCalled()
})
