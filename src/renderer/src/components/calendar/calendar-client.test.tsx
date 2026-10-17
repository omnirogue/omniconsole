// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConsoleCalendarFeed } from '../../../../shared/console-calendar-contract'
import type { ConsoleWorkflowResult } from '../../../../shared/console-workflow-types'
import { useCalendarFeed } from './calendar-client'

const api = vi.hoisted(() => ({ listCalendar: vi.fn() }))
vi.mock('@/lib/console-workflow-client', async (original) => ({
  ...(await original<object>()),
  consoleWorkflowApi: () => api
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const feed: ConsoleCalendarFeed = {
  entries: [],
  tasks: [],
  projects: [],
  projects_available: true,
  agent: [],
  overlay_errors: [],
  generated_at: '2026-09-15T12:00:00Z'
}

it('discards a prior principal response after an identity switch', async () => {
  let finish: (result: ConsoleWorkflowResult<ConsoleCalendarFeed>) => void = () => undefined
  api.listCalendar.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  api.listCalendar.mockResolvedValue({ ok: true, data: { ...feed, generated_at: 'new-account' } })
  const hook = renderHook(
    ({ scope }) => useCalendarFeed(scope, '2026-09-01', '2026-09-30', '', '', 0),
    { initialProps: { scope: 'alice' } }
  )
  hook.rerender({ scope: 'bob' })
  await waitFor(() => expect(hook.result.current.feed?.generated_at).toBe('new-account'))
  await act(async () => {
    finish({ ok: true, data: feed })
  })
  expect(hook.result.current.feed?.generated_at).toBe('new-account')
})

it('returns read failure as an error and preserves partial overlay failures', async () => {
  api.listCalendar.mockResolvedValueOnce({
    ok: false,
    error: { code: 'forbidden', message: 'Calendar access refused' }
  })
  const hook = renderHook(
    ({ revision }) => useCalendarFeed('alice', '2026-09-01', '2026-09-30', '', '', revision),
    { initialProps: { revision: 0 } }
  )
  await waitFor(() => expect(hook.result.current.error).toBe('Calendar access refused'))
  expect(hook.result.current.feed).toBeNull()
  api.listCalendar.mockResolvedValueOnce({
    ok: true,
    data: { ...feed, overlay_errors: [{ overlay: 'tasks', error: 'Deadline source unavailable' }] }
  })
  hook.rerender({ revision: 1 })
  await waitFor(() =>
    expect(hook.result.current.feed?.overlay_errors).toEqual([
      { overlay: 'tasks', error: 'Deadline source unavailable' }
    ])
  )
})
