// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RoutineConversationPanel } from './RoutineConversationPanel'

import type * as RoutineConversationDataModule from './routine-conversation-data'
const api = vi.hoisted(() => ({ runs: vi.fn(), getConversation: vi.fn() }))
vi.mock('@/components/sidebar/routines/team-routines-client', () => ({
  teamRoutinesApi: () => api
}))
vi.mock('./routine-conversation-data', async (original) => ({
  ...(await original<typeof RoutineConversationDataModule>()),
  conversationApi: () => api
}))
vi.mock('@/components/next-step/use-handoff-people', () => ({
  useHandoffPeople: () => ({ people: { phase: 'ready', value: [] }, employeeId: 'emp_me' })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
// Keep mount boundaries visible while avoiding portal layout in this state test.
vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>
}))
const routine = { id: 'rtn_demo', members: [], viewer_role: null }
const onOpenChange = vi.fn()
function view(open: boolean) {
  return (
    <RoutineConversationPanel
      routine={routine}
      name="Daily"
      schedule={null}
      open={open}
      onOpenChange={onOpenChange}
    />
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  api.runs.mockResolvedValue({ ok: true, data: [] })
  api.getConversation.mockResolvedValue({ ok: true, data: { ok: true, messages: [] } })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
it('does not fetch a closed routine and explains never-run routines', async () => {
  const mounted = render(view(false))
  expect(api.runs).not.toHaveBeenCalled()
  mounted.rerender(view(true))
  await screen.findByText('No runs yet — the AI starts a conversation each time this routine runs')
  expect(screen.queryByLabelText('Message the agent')).toBeNull()
})
it('explains legacy runs without a card and offers no composer', async () => {
  api.runs.mockResolvedValue({
    ok: true,
    data: [{ id: 'rr_1', board_task_id: null, finished_at: null }]
  })
  render(view(true))
  await screen.findByText('This run has no board card. Its conversation is unavailable.')
  expect(api.getConversation).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('Message the agent')).toBeNull()
})
it('uses the team-routines sign-in state', async () => {
  api.runs.mockResolvedValue({
    ok: false,
    error: { code: 'signed_in_required', message: 'Sign in' }
  })
  render(view(true))
  await screen.findByText('Sign in to see team routines.')
})
it('selects the latest run and stops polling when the sheet closes', async () => {
  vi.useFakeTimers()
  api.runs.mockResolvedValue({
    ok: true,
    data: [
      {
        id: 'rr_old',
        board_task_id: 'btk_old1',
        created_at: '2026-09-17',
        finished_at: '2026-09-17'
      },
      { id: 'rr_new', board_task_id: 'btk_new1', created_at: '2026-09-18', finished_at: null }
    ]
  })
  const mounted = render(view(true))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(api.getConversation).toHaveBeenCalledWith({ taskId: 'btk_new1' })
  mounted.rerender(view(false))
  const count = api.getConversation.mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000)
  })
  expect(api.getConversation).toHaveBeenCalledTimes(count)
})
it('refreshes a finished routine manually', async () => {
  render(view(true))
  await screen.findByText('No runs yet — the AI starts a conversation each time this routine runs')
  fireEvent.click(screen.getByText('Refresh runs'))
  expect(api.runs).toHaveBeenCalledTimes(2)
})
