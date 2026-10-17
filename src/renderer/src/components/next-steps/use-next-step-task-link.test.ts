// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useNextStepTaskLink } from './use-next-step-task-link'

type Call = { taskId: string | null; resolve: () => void; reject: () => void }

const mocks = vi.hoisted(() => ({
  taskId: null as string | null,
  calls: [] as Call[],
  tasks: { links: {}, loaded: true, load: () => {} }
}))
vi.mock('@/lib/session-task-sidebar-groups', () => ({
  sessionTaskRef: () => (mocks.taskId ? { taskId: mocks.taskId } : null)
}))
vi.mock('@/store/session-task-store', () => ({
  useSessionTasks: Object.assign(
    (select: (state: typeof mocks.tasks) => unknown) => select(mocks.tasks),
    { getState: () => mocks.tasks }
  )
}))
vi.mock('./next-steps-client', () => ({
  linkNextStepTask: (_conversation: unknown, taskId: string | null) =>
    new Promise<void>((resolve, reject) => {
      mocks.calls.push({ taskId, resolve, reject: () => reject(new Error('refused')) })
    })
}))

const SESSION = {} as SidebarSession
const SOURCE = { worktreeId: 'wt', paneKey: 'tab:1', kind: 'pty' as const }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  mocks.taskId = null
  mocks.calls.length = 0
})

it('a failed older link never erases a newer one, so a later unlink is still sent', async () => {
  const { rerender } = renderHook(() => useNextStepTaskLink(SESSION, SOURCE))
  for (const taskId of ['A', 'B', 'A']) {
    mocks.taskId = taskId
    rerender()
  }
  expect(mocks.calls.map((call) => call.taskId)).toEqual(['A', 'B', 'A'])
  mocks.calls[2]!.resolve()
  mocks.calls[0]!.reject()
  await settle()
  mocks.taskId = null
  rerender()
  expect(mocks.calls.map((call) => call.taskId)).toEqual(['A', 'B', 'A', null])
})
