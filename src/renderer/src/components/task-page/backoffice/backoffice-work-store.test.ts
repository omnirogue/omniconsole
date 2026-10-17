import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowRequestError } from '@/lib/console-workflow-client'
import { buildWorkViews } from '../../../../../shared/backoffice-work-views'
import type { HandoffQueue } from '../../../../../shared/console-handoff-contract'
import {
  collectQueuePages,
  collectTodoPages,
  isUnservedRead,
  TodoPageStale
} from './backoffice-work-pages'
import {
  invalidateBackofficeWork,
  loadBackofficeWork,
  loadMoreBackofficeTodo,
  loadMoreBackofficeMessages,
  selectBackofficePeerProject,
  toWorkViewsInput,
  useBackofficeWorkStore,
  type TodoFeed,
  type WorkReads
} from './backoffice-work-store'

const api = vi.hoisted(() => ({ list: vi.fn(), recipients: vi.fn() }))
vi.mock('@/components/handoffs/handoff-client', () => ({ handoffApi: () => api }))
const listTodo = vi.fn()
const listHumanActions = vi.fn()
const feed = vi.fn()

type Thread = HandoffQueue['threads'][number]

function thread(id: string): Thread {
  return {
    id,
    board_task_id: 'btk_aa',
    author_employee_id: 'emp_sal',
    recipient_employee_id: 'emp_iris',
    title: id,
    state: 'open',
    action: 'review',
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: '2026-09-11T10:00:00Z',
    files: [],
    reviews: []
  }
}

function pages(...contents: string[][]): (cursor: string | undefined) => Promise<HandoffQueue> {
  return async (cursor) => {
    const index = cursor ? Number(cursor.replace('page_', '')) : 0
    if (!contents[index]) {
      throw new Error('invalid_cursor')
    }
    return {
      assignee: 'emp_sal',
      threads: contents[index].map(thread),
      next_cursor: index + 1 < contents.length ? `page_${index + 1}` : null
    }
  }
}

function queue(threads: Thread[], extra: Partial<HandoffQueue> = {}): HandoffQueue {
  return { assignee: 'emp_sal', threads, next_cursor: null, ...extra }
}

function todoFeed(taskIds: string[], nextCursor: string | null = null): TodoFeed {
  return {
    ok: true as const,
    baseUrl: 'https://console.test',
    employeeId: 'emp_sal',
    generatedAt: null,
    items: taskIds.map((task_id) => ({ task_id, title: task_id })),
    awaitingVerification: [],
    counts: null,
    nextCursor,
    truncated: nextCursor !== null
  }
}

/** Todo pages by cursor: `page_1` answers the second page, and so on. */
function todoPages(...contents: string[][]): (cursor: string | undefined) => Promise<TodoFeed> {
  return async (cursor) => {
    const index = cursor ? Number(cursor.replace('page_', '')) : 0
    if (!contents[index]) {
      throw new Error('That is not a Todo page position.')
    }
    return todoFeed(contents[index], index + 1 < contents.length ? `page_${index + 1}` : null)
  }
}

/** The mocked preload answers Todo pages the way the main process does: ok results, never throws. */
function answerTodoPages(...contents: string[][]): void {
  const read = todoPages(...contents)
  listTodo.mockImplementation(async (args?: { cursor?: string }) => {
    try {
      return await read(args?.cursor)
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })
}

/** Every list answers empty except the sent view, which answers `sent()`. */
function answerSent(sent: () => unknown): void {
  api.list.mockImplementation(async (args: { view?: string } = {}) =>
    args.view === 'sent' ? sent() : { ok: true, data: queue([]) }
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', {
    api: { backoffice: { listTodo, feed }, consoleWorkflows: { listHumanActions } }
  })
  listTodo.mockResolvedValue(todoFeed([]))
  listHumanActions.mockResolvedValue({ ok: true, data: { ok: true, jobs: [] } })
  feed.mockResolvedValue({ ok: true, body: { projects: [] } })
  api.recipients.mockResolvedValue({ ok: true, data: { employees: [] } })
  answerSent(() => ({ ok: true, data: queue([], { view: 'sent' }) }))
  const idle = { phase: 'idle' } as const
  useBackofficeWorkStore.setState({
    scope: null,
    loadedAt: null,
    historyRequested: false,
    todo: idle,
    receivedOpen: idle,
    receivedHistory: idle,
    sent: idle,
    roster: idle,
    humanActions: idle,
    messages: idle
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function todoTaskIds(): string[] | string {
  const todo = useBackofficeWorkStore.getState().todo
  return todo.phase === 'ready' ? todo.value.items.map((item) => item.task_id) : todo.phase
}

function resolvedHistoryReads(): number {
  return api.list.mock.calls.filter(([args]) => args?.state === 'resolved').length
}

describe('collectTodoPages', () => {
  it('follows the Todo cursor to the last page and lists a card once', async () => {
    const feed = await collectTodoPages(todoPages(['btk_a', 'btk_b'], ['btk_b', 'btk_c']))
    expect(feed.items.map((item) => item.task_id)).toEqual(['btk_a', 'btk_b', 'btk_c'])
    expect(feed).toMatchObject({ nextCursor: null, truncated: false })
  })

  it('stops at the page bound and keeps the remaining cursor as truncation', async () => {
    const feed = await collectTodoPages(todoPages(['btk_a'], ['btk_b'], ['btk_c']), {
      maxPages: 2
    })
    expect(feed.items.map((item) => item.task_id)).toEqual(['btk_a', 'btk_b'])
    expect(feed).toMatchObject({ nextCursor: 'page_2', truncated: true })
  })

  it('keeps the earlier pages and the failing cursor when a later page fails', async () => {
    const feed = await collectTodoPages(async (cursor) => {
      if (cursor) {
        throw new Error('That is not a Todo page position.')
      }
      return todoFeed(['btk_a'], 'page_1')
    })
    expect(feed.items.map((item) => item.task_id)).toEqual(['btk_a'])
    expect(feed).toMatchObject({ nextCursor: 'page_1', truncated: true })
  })

  it('continues from a feed already held without re-reading its pages', async () => {
    const read = vi.fn(todoPages(['btk_a'], ['btk_b'], ['btk_c']))
    const feed = await collectTodoPages(read, { from: todoFeed(['btk_a'], 'page_1') })
    expect(feed.items.map((item) => item.task_id)).toEqual(['btk_a', 'btk_b', 'btk_c'])
    expect(read).not.toHaveBeenCalledWith(undefined)
  })

  it("keeps an older server's capped first page marked truncated", async () => {
    const feed = await collectTodoPages(async () => ({ ...todoFeed(['btk_a']), truncated: true }))
    expect(feed).toMatchObject({ nextCursor: null, truncated: true })
  })

  it('restarts a fresh walk once from its first page when a page position expired', async () => {
    let walks = 0
    const read = vi.fn(async (cursor: string | undefined) => {
      if (cursor === undefined) {
        walks += 1
        return todoFeed(walks === 1 ? ['btk_old1'] : ['btk_new1'], 'page_1')
      }
      if (walks === 1) {
        throw new TodoPageStale('expired')
      }
      return todoFeed(['btk_new2'])
    })
    const feed = await collectTodoPages(read)
    expect(feed.items.map((item) => item.task_id)).toEqual(['btk_new1', 'btk_new2'])
    expect(feed).toMatchObject({ nextCursor: null, truncated: false })
    expect(walks).toBe(2)
  })

  it('gives up honestly when the restarted walk expires again: short, and no dead cursor', async () => {
    const read = async (cursor: string | undefined): Promise<TodoFeed> => {
      if (cursor === undefined) {
        return todoFeed(['btk_a'], 'page_1')
      }
      throw new TodoPageStale('expired')
    }
    const feed = await collectTodoPages(read)
    expect(feed.items.map((item) => item.task_id)).toEqual(['btk_a'])
    expect(feed).toMatchObject({ nextCursor: null, truncated: true })
  })

  it('reports an expired position to the caller of a continued walk', async () => {
    await expect(
      collectTodoPages(
        async () => {
          throw new TodoPageStale('expired')
        },
        { from: todoFeed(['btk_a'], 'page_1') }
      )
    ).rejects.toBeInstanceOf(TodoPageStale)
  })
})

describe('loadBackofficeWork Todo pages', () => {
  it('reads the first pages through the preload and offers the rest as load more', async () => {
    answerTodoPages(['btk_1'], ['btk_2'], ['btk_3'], ['btk_4'], ['btk_5'])
    await loadBackofficeWork('scope-a')
    expect(todoTaskIds()).toEqual(['btk_1', 'btk_2', 'btk_3', 'btk_4'])
    expect(listTodo).toHaveBeenCalledWith({ cursor: 'page_3' })
    expect(toWorkViewsInput(useBackofficeWorkStore.getState(), []).todo?.truncated).toBe(true)
    await loadMoreBackofficeTodo('scope-a')
    expect(todoTaskIds()).toEqual(['btk_1', 'btk_2', 'btk_3', 'btk_4', 'btk_5'])
    expect(toWorkViewsInput(useBackofficeWorkStore.getState(), []).todo?.truncated).toBe(false)
  })

  it('does nothing on load more when no page follows or the scope differs', async () => {
    answerTodoPages(['btk_1'])
    await loadBackofficeWork('scope-a')
    await loadMoreBackofficeTodo('scope-a')
    await loadMoreBackofficeTodo('scope-b')
    expect(listTodo).toHaveBeenCalledTimes(1)
  })

  it('re-reads the list from its first page when the load-more position expired', async () => {
    // Why: the first walk stops at four pages with a fifth waiting; that fifth position expires.
    let expired = false
    listTodo.mockImplementation(async (args?: { cursor?: string }) => {
      if (!args?.cursor) {
        return expired ? todoFeed(['btk_fresh']) : todoFeed(['btk_1'], 'page_1')
      }
      if (expired) {
        return { ok: false, message: 'That Todo page position expired.', stale: true }
      }
      const index = Number(args.cursor.replace('page_', ''))
      return todoFeed([`btk_${index + 1}`], `page_${index + 1}`)
    })
    await loadBackofficeWork('scope-a')
    expect(todoTaskIds()).toEqual(['btk_1', 'btk_2', 'btk_3', 'btk_4'])
    expired = true
    await loadMoreBackofficeTodo('scope-a')
    expect(todoTaskIds()).toEqual(['btk_fresh'])
    expect(useBackofficeWorkStore.getState().todo).toMatchObject({ phase: 'ready' })
  })

  it('reads nothing on a second load more while the first is in flight', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let gated = false
    listTodo.mockImplementation(async (args?: { cursor?: string }) => {
      if (!args?.cursor) {
        return todoFeed(['btk_1'], 'page_1')
      }
      if (!gated) {
        return { ok: false, message: 'not yet' }
      }
      await gate
      return todoFeed(['btk_2'])
    })
    await loadBackofficeWork('scope-a')
    gated = true
    listTodo.mockClear()
    const first = loadMoreBackofficeTodo('scope-a')
    await loadMoreBackofficeTodo('scope-a')
    release()
    await first
    expect(listTodo.mock.calls.filter(([args]) => args?.cursor === 'page_1')).toHaveLength(1)
    expect(todoTaskIds()).toEqual(['btk_1', 'btk_2'])
  })

  it('reads every feed for a stale unforced load that arrives during a load more', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let gateOpen = false
    listTodo.mockImplementation(async (args?: { cursor?: string }) => {
      if (!args?.cursor) {
        return todoFeed(['btk_1'], 'page_1')
      }
      if (!gateOpen) {
        return { ok: false, message: 'not yet' }
      }
      await gate
      return todoFeed(['btk_2'])
    })
    await loadBackofficeWork('scope-a')
    gateOpen = true
    // Why: the list is past its freshness window when the person clicks load more and then opens Work.
    useBackofficeWorkStore.setState({ loadedAt: Date.now() - 120_000 })
    api.recipients.mockClear()
    const more = loadMoreBackofficeTodo('scope-a')
    const full = loadBackofficeWork('scope-a')
    release()
    await more
    await full
    // Why: the load more is not the full load; the roster (and every other feed) is read again.
    expect(api.recipients).toHaveBeenCalledTimes(1)
    expect(useBackofficeWorkStore.getState().todo).toMatchObject({ phase: 'ready' })
  })

  it('repeats the pages a load more opened when a later unforced read reloads the list', async () => {
    answerTodoPages(['btk_1'], ['btk_2'], ['btk_3'], ['btk_4'], ['btk_5'])
    await loadBackofficeWork('scope-a')
    await loadMoreBackofficeTodo('scope-a')
    expect(todoTaskIds()).toEqual(['btk_1', 'btk_2', 'btk_3', 'btk_4', 'btk_5'])
    // Why: past the freshness window every feed is read again; the fifth page is still the person's.
    useBackofficeWorkStore.setState({ loadedAt: Date.now() - 120_000 })
    await loadBackofficeWork('scope-a')
    expect(todoTaskIds()).toEqual(['btk_1', 'btk_2', 'btk_3', 'btk_4', 'btk_5'])
  })

  it('drops a reload that waited on a load more when the account changed meanwhile', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let gateOpen = false
    listTodo.mockImplementation(async (args?: { cursor?: string }) => {
      if (!args?.cursor) {
        return todoFeed(['btk_1'], 'page_1')
      }
      if (!gateOpen) {
        return { ok: false, message: 'not yet' }
      }
      await gate
      return todoFeed(['btk_2'])
    })
    await loadBackofficeWork('scope-a')
    gateOpen = true
    useBackofficeWorkStore.setState({ loadedAt: Date.now() - 120_000 })
    const more = loadMoreBackofficeTodo('scope-a')
    const waiter = loadBackofficeWork('scope-a')
    // Why: only the load more already in flight is gated; the next account reads freely.
    gateOpen = false
    await loadBackofficeWork('scope-b')
    api.recipients.mockClear()
    release()
    await more
    await waiter
    // Why: the account the person left never writes again, and never resets the one they opened.
    expect(useBackofficeWorkStore.getState().scope).toBe('scope-b')
    expect(todoTaskIds()).toEqual(['btk_1'])
    expect(api.recipients).not.toHaveBeenCalled()
  })

  it('drops the pages a load more appended once a forced reload superseded it', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let firstReads = 0
    listTodo.mockImplementation(async (args?: { cursor?: string }) => {
      if (!args?.cursor) {
        firstReads += 1
        return firstReads === 1 ? todoFeed(['btk_1'], 'page_1') : todoFeed(['btk_after'])
      }
      if (firstReads === 1 && !gateOpen) {
        return { ok: false, message: 'not yet' }
      }
      await gate
      return todoFeed(['btk_2'])
    })
    let gateOpen = false
    await loadBackofficeWork('scope-a')
    gateOpen = true
    const more = loadMoreBackofficeTodo('scope-a')
    invalidateBackofficeWork()
    release()
    await more
    await vi.waitFor(() => expect(todoTaskIds()).toEqual(['btk_after']))
  })
})

describe('loadBackofficeWork finished history', () => {
  it('never reads the resolved history for a cold load that did not ask for it', async () => {
    await loadBackofficeWork('scope-a')
    expect(resolvedHistoryReads()).toBe(0)
    const state = useBackofficeWorkStore.getState()
    expect(state.receivedHistory).toEqual({ phase: 'idle' })
    const input = toWorkViewsInput(state, [])
    expect(input.received.history).toEqual([])
    expect(buildWorkViews(input).gaps).toEqual([])
  })

  it('reads only the history when a lens asks for it after a fresh load', async () => {
    await loadBackofficeWork('scope-a')
    const calls = listTodo.mock.calls.length
    await loadBackofficeWork('scope-a', { history: true })
    expect(resolvedHistoryReads()).toBe(1)
    expect(listTodo).toHaveBeenCalledTimes(calls)
    expect(useBackofficeWorkStore.getState().receivedHistory).toMatchObject({ phase: 'ready' })
  })

  it('keeps reading the history once asked for, including after a mutation', async () => {
    await loadBackofficeWork('scope-a', { history: true })
    expect(resolvedHistoryReads()).toBe(1)
    invalidateBackofficeWork()
    await vi.waitFor(() => expect(resolvedHistoryReads()).toBe(2))
  })

  it('forgets the request when the scope changes', async () => {
    await loadBackofficeWork('scope-a', { history: true })
    await loadBackofficeWork('scope-b')
    expect(useBackofficeWorkStore.getState().historyRequested).toBe(false)
    expect(resolvedHistoryReads()).toBe(1)
  })
})

describe('collectQueuePages', () => {
  it('follows the cursor to the last page and keeps every thread once', async () => {
    const queue = await collectQueuePages(pages(['hth_a', 'hth_b'], ['hth_b', 'hth_c']))
    expect(queue.threads.map((row) => row.id)).toEqual(['hth_a', 'hth_b', 'hth_c'])
    expect(queue.next_cursor).toBeNull()
  })

  it('stops at the page bound and keeps the remaining cursor', async () => {
    const queue = await collectQueuePages(pages(['hth_a'], ['hth_b'], ['hth_c']), 2)
    expect(queue.threads.map((row) => row.id)).toEqual(['hth_a', 'hth_b'])
    expect(queue.next_cursor).toBe('page_2')
  })

  it('keeps earlier pages when a later page fails, reporting the rest as unread', async () => {
    const read = async (cursor: string | undefined): Promise<HandoffQueue> => {
      if (cursor) {
        throw new Error('This cursor does not continue this list')
      }
      return { assignee: 'emp_sal', threads: [thread('hth_a')], next_cursor: 'page_1' }
    }
    const queue = await collectQueuePages(read)
    expect(queue.threads.map((row) => row.id)).toEqual(['hth_a'])
    expect(queue.next_cursor).toBe('page_1')
  })
})

describe('toWorkViewsInput', () => {
  const idle = { phase: 'idle' } as const

  it('marks a list the client stopped paging as truncated', () => {
    const ready = (next: string | null): WorkReads['sent'] => ({
      phase: 'ready',
      value: { assignee: 'emp_sal', threads: [], next_cursor: next }
    })
    const reads: WorkReads = {
      todo: idle,
      receivedOpen: ready('page_4'),
      receivedHistory: ready(null),
      sent: ready('page_4'),
      roster: idle,
      humanActions: idle,
      messages: idle
    }
    expect(toWorkViewsInput(reads, []).truncated).toEqual({
      received: true,
      history: false,
      sent: true
    })
  })

  it('tells a failed sent read from one the server does not serve', () => {
    const reads: WorkReads = {
      todo: idle,
      receivedOpen: idle,
      receivedHistory: idle,
      sent: { phase: 'error', message: 'down', previous: null },
      roster: idle,
      humanActions: idle,
      messages: idle
    }
    expect(toWorkViewsInput(reads, [])).toMatchObject({ sent: null, sentFailed: true })
    expect(toWorkViewsInput({ ...reads, sent: { phase: 'not-served' } }, [])).toMatchObject({
      sent: null,
      sentFailed: false
    })
  })

  it('tells a failed human-jobs read from one the server does not serve', () => {
    const reads: WorkReads = {
      todo: idle,
      receivedOpen: idle,
      receivedHistory: idle,
      sent: idle,
      roster: idle,
      humanActions: { phase: 'error', message: 'down', previous: null },
      messages: idle
    }
    expect(toWorkViewsInput(reads, [])).toMatchObject({ humanJobs: null, humanJobsFailed: true })
    expect(toWorkViewsInput({ ...reads, humanActions: { phase: 'not-served' } }, [])).toMatchObject(
      { humanJobs: null, humanJobsFailed: false }
    )
  })
})

describe('toWorkViewsInput viewer', () => {
  it('names the viewer from a handoff queue when the Todo read failed', () => {
    const idle = { phase: 'idle' } as const
    const reads: WorkReads = {
      todo: { phase: 'error', message: 'HTTP 500', previous: null },
      receivedOpen: { phase: 'ready', value: queue([]) },
      receivedHistory: idle,
      sent: idle,
      roster: idle,
      humanActions: idle,
      messages: idle
    }
    expect(toWorkViewsInput(reads, []).employeeId).toBe('emp_sal')
    expect(toWorkViewsInput({ ...reads, receivedOpen: idle }, []).employeeId).toBeNull()
  })
})

describe('loadBackofficeWork human actions read', () => {
  const stage = {
    id: 'job_stage',
    task_id: 'btk_aa',
    title: 'Approve the plan',
    can_decide: true,
    blockers: [],
    workflow_state: 'awaiting_human',
    policy: { workflow: { action: 'approve', actor_id: 'emp_sal', dispatch_id: 'wf_1' } }
  }

  it('reads the stages assigned to this person with the other feeds', async () => {
    listHumanActions.mockResolvedValue({ ok: true, data: { ok: true, jobs: [stage] } })
    await loadBackofficeWork('scope-a')
    const state = useBackofficeWorkStore.getState()
    expect(state.humanActions).toMatchObject({ phase: 'ready', value: [stage] })
    // Why: a stage is listed with the rest of the work; Needs You is people's handoffs only.
    const views = buildWorkViews(toWorkViewsInput(state, []))
    expect(views.all.map((row) => row.key)).toContain('job:job_stage')
    expect(views.needsYou.map((row) => row.key)).not.toContain('job:job_stage')
  })

  it('treats a server without the read as not served, and a failure as unavailable', async () => {
    listHumanActions.mockResolvedValue({
      ok: false,
      error: { code: 'backoffice_refused', message: 'no route', status: 404 }
    })
    await loadBackofficeWork('scope-a')
    expect(useBackofficeWorkStore.getState().humanActions).toEqual({ phase: 'not-served' })
    listHumanActions.mockResolvedValue({
      ok: false,
      error: { code: 'backoffice_refused', message: 'down', status: 502 }
    })
    await loadBackofficeWork('scope-a', { force: true })
    expect(useBackofficeWorkStore.getState().humanActions).toMatchObject({
      phase: 'error',
      message: 'down'
    })
  })
})

describe('isUnservedRead', () => {
  const refused = (status: number, code: string) =>
    new WorkflowRequestError({ code, message: 'refused', status })

  it.each([
    [404, 'capability_unavailable'],
    [405, 'backoffice_refused'],
    [422, 'invalid_view'],
    [422, 'hub-read-invalid'],
    [400, 'invalid_view']
  ])('treats %i %s as not served', (status, code) => {
    expect(isUnservedRead(refused(status, code))).toBe(true)
  })

  it.each([
    [422, 'backoffice_refused'],
    [400, 'invalid_cursor'],
    [403, 'queue_forbidden'],
    [500, 'backoffice_refused']
  ])('treats %i %s as a real refusal', (status, code) => {
    expect(isUnservedRead(refused(status, code))).toBe(false)
  })

  it('never treats an unreachable server as not served', () => {
    expect(isUnservedRead(new Error('fetch failed'))).toBe(false)
  })
})

describe('loadBackofficeWork sent read', () => {
  it('treats an answer without the sent view echo as not served', async () => {
    answerSent(() => ({ ok: true, data: queue([thread('hth_received')]) }))
    await loadBackofficeWork('scope-a')
    const state = useBackofficeWorkStore.getState()
    expect(state.sent).toEqual({ phase: 'not-served' })
    expect(buildWorkViews(toWorkViewsInput(state, [])).gaps).toContain('sent-not-served')
  })

  it('keeps an answer that echoes the sent view', async () => {
    answerSent(() => ({ ok: true, data: queue([thread('hth_s')], { view: 'sent' }) }))
    await loadBackofficeWork('scope-a')
    const state = useBackofficeWorkStore.getState()
    expect(state.sent).toMatchObject({ phase: 'ready' })
    expect(buildWorkViews(toWorkViewsInput(state, [])).gaps).toEqual([])
  })

  it('names a sent read that failed as unavailable, not as unserved', async () => {
    answerSent(() => ({ ok: false, error: { code: 'backoffice_unavailable', message: 'down' } }))
    await loadBackofficeWork('scope-a')
    const state = useBackofficeWorkStore.getState()
    expect(state.sent).toMatchObject({ phase: 'error' })
    const gaps = buildWorkViews(toWorkViewsInput(state, [])).gaps
    expect(gaps).toContain('sent-unavailable')
    expect(gaps).not.toContain('sent-not-served')
  })
})

describe('loadBackofficeWork after a mutation', () => {
  it('starts new reads instead of reusing those in flight and keeps only the new answer', async () => {
    let answerStale: (value: ReturnType<typeof todoFeed>) => void = () => undefined
    listTodo
      .mockReturnValueOnce(
        new Promise((resolve) => {
          answerStale = resolve
        })
      )
      .mockResolvedValueOnce(todoFeed(['btk_fresh']))
    const stale = loadBackofficeWork('scope-a')
    invalidateBackofficeWork()
    expect(listTodo).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(useBackofficeWorkStore.getState().loadedAt).not.toBeNull())
    answerStale(todoFeed(['btk_stale']))
    await stale
    const todo = useBackofficeWorkStore.getState().todo
    expect(todo.phase === 'ready' ? todo.value.items.map((item) => item.task_id) : todo).toEqual([
      'btk_fresh'
    ])
    await loadBackofficeWork('scope-a')
    expect(listTodo).toHaveBeenCalledTimes(2)
  })

  it('lets unforced callers share the reads already in flight', async () => {
    const first = loadBackofficeWork('scope-a')
    expect(loadBackofficeWork('scope-a')).toBe(first)
    await first
    expect(listTodo).toHaveBeenCalledTimes(1)
  })
})

describe('loadBackofficeWork peer messages read', () => {
  const asked = {
    id: 'msg_1',
    project_id: 'prj_shared',
    task_id: null,
    sender_session_id: 'sess_gamma',
    recipient_session_id: 'sess_sal',
    sender_employee_id: 'emp_gamma',
    recipient_employee_id: 'emp_sal',
    purpose: 'question',
    summary: 'Which deck?',
    state: 'delivered',
    created_at: 1_789_200_000,
    delivered_at: 1_789_200_060,
    replied_at: null,
    resolved_at: null,
    expires_at: null,
    reply: null
  }

  it('publishes older history and preserves its depth on a forced deletion refresh', async () => {
    let prefix = ''
    feed.mockImplementation(async ({ path }: { path: string }) => ({
      ok: true,
      body: path.endsWith('/projects')
        ? { projects: [{ id: 'prj_shared', name: 'Shared' }] }
        : {
            threads: [{ ...asked, id: prefix + (path.includes('cursor=') ? 'older' : 'newest') }],
            next_cursor: path.includes('cursor=') ? 'oldest_cursor' : 'older_cursor'
          }
    }))
    await loadBackofficeWork('scope-a')
    expect(useBackofficeWorkStore.getState().messagesMore).toBe(true)
    await loadMoreBackofficeMessages('scope-a')
    expect(useBackofficeWorkStore.getState().messages).toMatchObject({
      phase: 'ready',
      value: [{ id: 'newest' }, { id: 'older' }]
    })
    prefix = 'remaining_'
    feed.mockClear()
    await loadBackofficeWork('scope-a', { force: true })
    expect(useBackofficeWorkStore.getState().messages).toMatchObject({
      phase: 'ready',
      value: [{ id: 'remaining_newest' }, { id: 'remaining_older' }]
    })
    expect(feed.mock.calls.filter(([args]) => args.path.includes('/threads?'))).toHaveLength(2)
    expect(useBackofficeWorkStore.getState().messagesMore).toBe(true)
  })

  it('reads the selected project’s message pages with the other feeds', async () => {
    feed.mockImplementation(async ({ path }: { path: string }) => {
      if (path === '/api/estate/peers/projects') {
        return { ok: true, body: { projects: [{ id: 'prj_shared', name: 'Shared' }] } }
      }
      if (path === '/api/estate/peers/threads?project_id=prj_shared&limit=20') {
        return { ok: true, body: { threads: [asked], next_cursor: 'c1' } }
      }
      if (path === '/api/estate/peers/threads?project_id=prj_shared&limit=20&cursor=c1') {
        return { ok: true, body: { threads: [{ ...asked, id: 'msg_2' }], next_cursor: null } }
      }
      return { ok: false, message: `unexpected ${path}` }
    })
    await loadBackofficeWork('scope-a', { peerProject: 'prj_shared' })
    const state = useBackofficeWorkStore.getState()
    expect(state.messages).toMatchObject({ phase: 'ready' })
    const views = buildWorkViews(toWorkViewsInput(state, []))
    expect(views.all.filter((row) => row.source === 'message').map((row) => row.key)).toEqual([
      'message:msg_1',
      'message:msg_2'
    ])
    expect(views.needsYou.map((row) => row.key)).toEqual(['message:msg_1', 'message:msg_2'])
  })

  it('a peer 304 produces no store update or follow-on page request', async () => {
    vi.useFakeTimers()
    try {
      feed.mockImplementation(async ({ path }: { path: string }) => ({
        ok: true,
        body: path.endsWith('/projects')
          ? { projects: [{ id: 'prj_shared', name: 'Shared' }] }
          : { threads: [asked], next_cursor: path.includes('cursor=') ? null : 'c1' }
      }))
      await loadBackofficeWork('scope-a', { peerProject: 'prj_shared' })
      const previous = useBackofficeWorkStore.getState().messages
      const changed = vi.fn()
      const unsubscribe = useBackofficeWorkStore.subscribe(changed)
      feed.mockClear().mockResolvedValue({ ok: true, notModified: true, body: {} })
      await vi.advanceTimersByTimeAsync(60_000)
      await selectBackofficePeerProject('scope-a', 'prj_shared')
      unsubscribe()
      expect(changed).not.toHaveBeenCalled()
      expect(useBackofficeWorkStore.getState().messages).toBe(previous)
      expect(feed).toHaveBeenCalledTimes(1)
      expect(feed.mock.calls[0][0].path).not.toContain('cursor=')
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a server without the peers routes as not served, and a failed project list as unavailable', async () => {
    feed.mockResolvedValue({ ok: false, message: 'The backoffice answered HTTP 404.' })
    await loadBackofficeWork('scope-a')
    expect(useBackofficeWorkStore.getState().messages).toEqual({ phase: 'not-served' })
    feed.mockResolvedValue({ ok: false, message: 'The backoffice answered HTTP 502.' })
    await loadBackofficeWork('scope-a', { force: true })
    expect(useBackofficeWorkStore.getState().messages).toMatchObject({
      phase: 'error',
      message: 'The backoffice answered HTTP 502.'
    })
    expect(buildWorkViews(toWorkViewsInput(useBackofficeWorkStore.getState(), [])).gaps).toContain(
      'messages-unavailable'
    )
  })

  it('reads messages as not served on a build without the feed bridge', async () => {
    vi.stubGlobal('window', {
      api: { backoffice: { listTodo }, consoleWorkflows: { listHumanActions } }
    })
    await loadBackofficeWork('scope-a')
    expect(useBackofficeWorkStore.getState().messages).toEqual({ phase: 'not-served' })
  })
})
