// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { JiraSessionTask } from '../../../../../shared/console-jira-session-contract'
import { attachSessionsToTask } from './SessionBulkAttachToTask'
const mocks = vi.hoisted(() => ({ scope: 'sal', attach: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (state: object) => unknown) => select({}), {
    getState: () => ({})
  })
}))
vi.mock('@/lib/console-account-scope', () => ({ selectConsoleAccountScope: () => mocks.scope }))
vi.mock('@/lib/attach-jira-session', () => ({ attachSessionToJira: mocks.attach }))
vi.mock('@/components/tasks/AttachToTaskDialog', () => ({ AttachToTaskDialog: () => null }))
const items = ['a', 'b'].map((key) => ({
  key,
  label: key,
  session: { label: key, paneKey: `tab:${key}`, kind: 'terminal' } as SidebarSession
}))
const task = { work_ref: { issue_key: 'APU-1' } } as JiraSessionTask
beforeEach(() => {
  mocks.scope = 'sal'
  mocks.attach.mockReset()
})
it('reports confirmed links and refusals separately without writing a fallback cache', async () => {
  mocks.attach.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Revision conflict'))
  expect(await attachSessionsToTask(items, task)).toEqual([
    { key: 'a', label: 'a', ok: true },
    { key: 'b', label: 'b', ok: false, message: 'Revision conflict' }
  ])
  expect(mocks.attach).toHaveBeenCalledTimes(2)
})
it('stops subsequent writes when the account switches mid-selection', async () => {
  mocks.attach.mockImplementationOnce(async () => {
    mocks.scope = 'uma'
    return {}
  })
  const result = await attachSessionsToTask(items, task, 'sal')
  expect(result[1]).toMatchObject({ ok: false })
  expect(mocks.attach).toHaveBeenCalledTimes(1)
})
it('keeps the context warning from a confirmed link', async () => {
  mocks.attach.mockResolvedValue({ contextWarning: 'Context needs refresh' })
  expect((await attachSessionsToTask(items.slice(0, 1), task))[0]).toMatchObject({
    ok: true,
    message: 'Context needs refresh'
  })
})
