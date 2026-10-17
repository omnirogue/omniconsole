import { beforeEach, expect, it, vi } from 'vitest'
import type { WorkRow } from '../../../../../shared/backoffice-work-views'
import { canSelectWorkRow, runBulkWorkAction } from './backoffice-bulk-actions'
import { finishNextStep } from '@/components/next-step/next-step-actions'
import { completeWorkHandoff } from './backoffice-handoff-completion'
import { archiveWorkHandoff } from './backoffice-handoff-archive'
import { archiveWorkMessage } from './backoffice-message-archive'
vi.mock('@/components/next-step/next-step-actions', () => ({ finishNextStep: vi.fn() }))
vi.mock('./backoffice-handoff-completion', () => ({ completeWorkHandoff: vi.fn() }))
vi.mock('./backoffice-handoff-archive', () => ({ archiveWorkHandoff: vi.fn() }))
vi.mock('./backoffice-message-archive', () => ({ archiveWorkMessage: vi.fn() }))
const archiveTask = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api: { backoffice: { archiveTask } } })
})
const row = (id: string) =>
  ({ key: id, title: id, todo: { task_id: id, state_revision: 7 } }) as WorkRow
it('preserves partial failures, processes each task once and never retries a write', async () => {
  archiveTask
    .mockResolvedValueOnce({ ok: true })
    .mockRejectedValueOnce(new Error('Connection lost'))
  const result = await runBulkWorkAction(
    [row('one'), row('one'), row('two')],
    'archive',
    () => true
  )
  expect(result.map((entry) => entry.ok)).toEqual([true, false])
  expect(result[1]?.message).toBe('Connection lost')
  expect(archiveTask).toHaveBeenCalledTimes(2)
})
it('uses revision-checked completion and retains evidence refusals', async () => {
  vi.mocked(finishNextStep).mockResolvedValue({
    ok: false,
    message: 'Evidence required',
    evidenceItem: row('one').todo
  })
  const result = await runBulkWorkAction([row('one')], 'complete', () => true)
  expect(finishNextStep).toHaveBeenCalledWith({ kind: 'card', item: row('one').todo }, null)
  expect(result[0]).toMatchObject({ ok: false, message: 'Evidence required' })
})
it('stops before another mutation after an account switch', async () => {
  let current = true
  archiveTask.mockImplementation(async () => {
    current = false
    return { ok: true }
  })
  await runBulkWorkAction([row('one'), row('two')], 'archive', () => current)
  expect(archiveTask).toHaveBeenCalledTimes(1)
})

const owner = { scope: 'scope', viewer: 'emp_me' }
const threadRow = (id: string, recipient = 'emp_me') =>
  ({
    key: `thread:${id}`,
    title: id,
    thread: {
      id,
      board_task_id: 'btk_same',
      author_employee_id: 'emp_other',
      recipient_employee_id: recipient
    }
  }) as WorkRow

it('selects own sent and received handoffs but excludes another person’s rows', () => {
  expect(canSelectWorkRow(threadRow('one'), 'emp_me')).toBe(true)
  expect(canSelectWorkRow(threadRow('one'), 'emp_other')).toBe(true)
  expect(canSelectWorkRow(threadRow('one'), null)).toBe(false)
  expect(canSelectWorkRow(threadRow('one'), 'emp_unrelated')).toBe(false)
})

it('archives handoffs separately on the same card without archiving that card', async () => {
  vi.mocked(archiveWorkHandoff).mockResolvedValue({ ok: true, message: 'Archived for you' })
  const linked = { ...threadRow('one'), todo: row('btk_same').todo }
  const result = await runBulkWorkAction([linked, threadRow('two')], 'archive', () => true, owner)
  expect(result.map((item) => item.ok)).toEqual([true, true])
  expect(archiveWorkHandoff).toHaveBeenCalledTimes(2)
  expect(archiveWorkHandoff).toHaveBeenNthCalledWith(1, 'one', true, owner, expect.any(Function))
  expect(archiveTask).not.toHaveBeenCalled()
})

it('finishes a handoff referenced by a Todo action rather than completing its card', async () => {
  vi.mocked(completeWorkHandoff).mockResolvedValue({ ok: true, message: 'Completed' })
  const linked = {
    ...row('btk_same'),
    todo: { ...row('btk_same').todo!, primary_action: { handoff_thread_id: 'hth_one' } }
  }
  await runBulkWorkAction([linked], 'complete', () => true, owner)
  expect(completeWorkHandoff).toHaveBeenCalledWith('hth_one', owner, expect.any(Function))
  expect(finishNextStep).not.toHaveBeenCalled()
})

it('deduplicates a thread across row keys and gives each selected row its result', async () => {
  vi.mocked(completeWorkHandoff).mockResolvedValue({ ok: false, message: 'Still open' })
  const result = await runBulkWorkAction(
    [threadRow('one'), { ...threadRow('one'), key: 'linked:one' }],
    'complete',
    () => true,
    owner
  )
  expect(completeWorkHandoff).toHaveBeenCalledTimes(1)
  expect(result).toHaveLength(2)
  expect(result.every((item) => !item.ok && item.message === 'Still open')).toBe(true)
})

it('uses the same personal archive action with false to restore', async () => {
  vi.mocked(archiveWorkHandoff).mockResolvedValue({ ok: true, message: 'Restored for you' })
  await runBulkWorkAction([threadRow('one')], 'restore', () => true, owner)
  expect(archiveWorkHandoff).toHaveBeenCalledWith('one', false, owner, expect.any(Function))
})

it('deletes each selected message once and retains partial refusals', async () => {
  const message = (id: string, recipient = 'emp_me') =>
    ({
      key: `message:${id}`,
      title: id,
      message: { id, sender_employee_id: 'emp_other', recipient_employee_id: recipient }
    }) as WorkRow
  vi.mocked(archiveWorkMessage).mockResolvedValue({ ok: true, message: '' })
  expect(canSelectWorkRow(message('one'), 'emp_me')).toBe(true)
  expect(canSelectWorkRow(message('one'), 'emp_other')).toBe(true)
  expect(canSelectWorkRow(message('one'), 'emp_stranger')).toBe(false)
  const results = await runBulkWorkAction(
    [message('one'), message('one'), message('two', 'emp_unrelated')],
    'archive',
    () => true,
    owner
  )
  expect(archiveWorkMessage).toHaveBeenCalledTimes(1)
  expect(archiveWorkMessage).toHaveBeenCalledWith('one', true, owner, expect.any(Function))
  expect(results.map((result) => result.ok)).toEqual([true, false])
  expect(archiveTask).not.toHaveBeenCalled()
  expect(finishNextStep).not.toHaveBeenCalled()
})
