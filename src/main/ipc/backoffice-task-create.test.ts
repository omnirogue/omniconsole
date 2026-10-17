import { beforeEach, expect, it, vi } from 'vitest'
import { registerBackofficeHandlers } from './backoffice'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => Promise<unknown>>(),
  create: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, args: unknown) => Promise<unknown>) =>
      fixture.handlers.set(name, handler)
  }
}))
vi.mock('../backoffice/backoffice-task-create', () => ({ createBackofficeTask: fixture.create }))
vi.mock('../backoffice/backoffice-config', () => ({ testBackofficeConnection: vi.fn() }))
vi.mock('../backoffice/backoffice-work', () => ({
  archiveBackofficeTask: vi.fn(),
  completeBackofficeTask: vi.fn(),
  fetchBackofficeFeed: vi.fn(),
  fetchBackofficeTodo: vi.fn()
}))
vi.mock('../backoffice/backoffice-inbox-send', () => ({ sendInboxMessage: vi.fn() }))

beforeEach(() => {
  fixture.handlers.clear()
  fixture.create
    .mockReset()
    .mockResolvedValue({ ok: true, taskId: 'btk_reliability', title: 'Reliable IDE' })
  registerBackofficeHandlers()
})

it('passes the chosen outcome, plan and goal through the actual create IPC handler', async () => {
  const input = {
    title: 'Reliable IDE',
    acceptanceCriteria: 'One retained workflow after restart.',
    taskPlan: {
      version: 1,
      completion_mode: 'deliverable',
      steps: [{ id: 'review', title: 'Sal reviews the receipt', actor_ids: ['emp_sal'] }]
    },
    goalId: 'cgl_reliability',
    companyId: 'co_os',
    unitId: 'org_ops'
  }
  await fixture.handlers.get('backoffice:createTask')!({}, input)
  expect(fixture.create).toHaveBeenCalledWith(input)
})

it.each([
  { acceptanceCriteria: 123 },
  { acceptanceCriteria: 'x'.repeat(8001) },
  { taskPlan: { version: 1, steps: [], completion_mode: 'unknown' } }
])('refuses malformed outcome data without silently creating a task: %o', async (patch) => {
  const result = await fixture.handlers.get('backoffice:createTask')!(
    {},
    { title: 'Reliable IDE', ...patch }
  )
  expect(result).toMatchObject({ ok: false })
  expect(fixture.create).not.toHaveBeenCalled()
})
