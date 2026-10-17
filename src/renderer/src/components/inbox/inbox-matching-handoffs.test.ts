import { beforeEach, expect, it, vi } from 'vitest'
import { enumerateInboxHandoffs } from './inbox-matching-handoffs'
import type { ConsoleHandoffApi, HandoffQueue } from '../../../../shared/console-handoff-contract'

const api = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/components/handoffs/handoff-client', () => ({ handoffApi: () => api }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
type Args = NonNullable<Parameters<ConsoleHandoffApi['list']>[0]>
function thread(id: string, sent = false): HandoffQueue['threads'][number] {
  return {
    id,
    title: id,
    board_task_id: null,
    author_employee_id: sent ? 'emp_me' : 'emp_other',
    recipient_employee_id: sent ? 'emp_other' : 'emp_me',
    state: 'open',
    action: null,
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: '2026-09-15T00:00:00Z',
    files: [],
    reviews: []
  }
}
const page = (
  args: Args,
  threads: HandoffQueue['threads'][number][],
  cursor: string | null = null
) => ({
  ok: true,
  data: {
    assignee: 'emp_me',
    ...(args.view ? { view: args.view } : {}),
    threads,
    next_cursor: cursor
  }
})
const options = { viewer: 'emp_me', isCurrent: () => true }
beforeEach(() => {
  vi.resetAllMocks()
  api.list.mockImplementation(async (args: Args) => page(args, []))
})

it('walks received, resolved and sent queues and deduplicates a personal selection', async () => {
  api.list.mockImplementation(async (args: Args) => {
    if (args.view === 'sent') {
      return page(args, [thread('hth_sent', true)])
    }
    if (args.state === 'resolved') {
      return page(args, [{ ...thread('hth_old'), state: 'resolved' }])
    }
    return args.cursor
      ? page(args, [thread('hth_second')])
      : page(args, [thread('hth_first')], 'next')
  })
  const result = await enumerateInboxHandoffs(options)
  expect(result.complete).toBe(true)
  expect(result.rows.map((row) => row.key)).toEqual([
    'handoff:hth_first',
    'handoff:hth_old',
    'handoff:hth_sent',
    'handoff:hth_second'
  ])
  expect(api.list).toHaveBeenCalledTimes(4)
  expect(api.list).toHaveBeenLastCalledWith({ cursor: 'next' })
})

it('retains a confirmed subset when a source fails without claiming all', async () => {
  api.list.mockImplementation(async (args: Args) => {
    if (args.view === 'sent') {
      throw new Error('Sent history unavailable')
    }
    return page(args, args.state ? [] : [thread('hth_one')])
  })
  const result = await enumerateInboxHandoffs(options)
  expect(result).toMatchObject({
    complete: false,
    stopped: 'unavailable',
    errors: ['Sent history unavailable']
  })
  expect(result.rows).toHaveLength(1)
})

it('does not accept another participant’s queue into the selected snapshot', async () => {
  api.list.mockImplementation(async (args: Args) => ({
    ...page(args, [thread('hth_one')]),
    data: { ...page(args, []).data, assignee: 'emp_other' }
  }))
  expect(await enumerateInboxHandoffs(options)).toMatchObject({
    complete: false,
    stopped: 'unavailable',
    rows: []
  })
})

it('returns a bounded snapshot with an honest limit', async () => {
  api.list.mockImplementation(async (args: Args) =>
    page(args, [thread(`hth_${args.view ?? 'received'}`, args.view === 'sent')], 'next')
  )
  const result = await enumerateInboxHandoffs({ ...options, maxPages: 1 })
  expect(result).toMatchObject({ complete: false, stopped: 'limit', pagesRead: 1 })
  expect(api.list).toHaveBeenCalledTimes(1)
})

it('stops before the next page after Cancel while retaining confirmed rows', async () => {
  let cancelled = false
  api.list.mockImplementation(async (args: Args) => page(args, [thread('hth_one')], 'next'))
  const result = await enumerateInboxHandoffs({
    ...options,
    isCancelled: () => cancelled,
    onProgress: () => {
      cancelled = true
    }
  })
  expect(result).toMatchObject({ complete: false, stopped: 'cancelled', pagesRead: 1 })
  expect(result.rows).toHaveLength(1)
  expect(api.list).toHaveBeenCalledTimes(1)
})

it('rejects account changes before exposing an in-flight page', async () => {
  let active = true
  api.list.mockImplementation(async (args: Args) => {
    active = false
    return page(args, [thread('hth_one')])
  })
  await expect(enumerateInboxHandoffs({ ...options, isCurrent: () => active })).rejects.toThrow(
    'account changed'
  )
  expect(api.list).toHaveBeenCalledTimes(1)
})

it('does not claim all when an older server omits the pagination verdict', async () => {
  api.list.mockImplementation(async (args: Args) => ({
    ok: true,
    data: { ...page(args, []).data, next_cursor: undefined }
  }))
  expect(await enumerateInboxHandoffs(options)).toMatchObject({
    complete: false,
    stopped: 'unavailable'
  })
})

it('continues beyond a bounded action from saved cursors rather than replaying first pages', async () => {
  api.list.mockImplementation(async (args: Args) => {
    if (args.state || args.view) {
      return page(args, [])
    }
    return args.cursor
      ? page(args, [thread('hth_second')])
      : page(args, [thread('hth_first')], 'next')
  })
  const first = await enumerateInboxHandoffs({ ...options, maxPages: 3 })
  expect(first).toMatchObject({ complete: false, stopped: 'limit', pagesRead: 3 })
  expect(first.continuation).toHaveLength(1)
  const final = await enumerateInboxHandoffs({ ...options, from: first })
  expect(final).toMatchObject({ complete: true, stopped: null, pagesRead: 4, continuation: [] })
  expect(final.rows.map((row) => row.key)).toEqual(['handoff:hth_first', 'handoff:hth_second'])
  expect(api.list).toHaveBeenLastCalledWith({ cursor: 'next' })
})
