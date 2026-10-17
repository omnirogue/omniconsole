// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AttentionWorkSummary } from '@/components/attention/AttentionWorkSummary'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { TooltipProvider } from '@/components/ui/tooltip'
import { upNextFixture } from '@/components/next-action/up-next-fixture'
import { UP_NEXT_RPC } from '../../../../../shared/up-next-types'
import {
  BackofficeTodoListHost,
  type BackofficeTodoListHostProps
} from './backoffice-todo-list-host'
import { waitLaterKeyForCard } from '@/lib/wait-later'
import { useWaitLater } from '@/store/wait-later-store'
import { useBackofficeWorkFocus } from './backoffice-work-selection'
import { useBackofficeWorkStore } from './backoffice-work-store'

// These cover the hand composer itself, which ships behind a flag that is off.
vi.mock('@/components/next-action/up-next-composer-flag', () => ({
  UP_NEXT_COMPOSER_ENABLED: true
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      params && name in params ? String(params[name]) : match
    ),
  i18n: { language: 'en' }
}))
const api = vi.hoisted(() => ({
  list: vi.fn(),
  recipients: vi.fn(),
  get: vi.fn(),
  markRead: vi.fn()
}))
const upNextCardState = vi.hoisted(() => ({ draftAdded: false, calls: [] as string[] }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async (_target: unknown, method: string) => {
    upNextCardState.calls.push(method)
    const base = upNextFixture('busy')
    const draftPrompt = {
      id: 'draft:1',
      kind: 'prompt' as const,
      state: 'draft' as const,
      number: '1',
      locked: false,
      text: 'Is there anything else we can do to improve?',
      target: { kind: 'current' as const },
      when: 'now' as const
    }
    const blocks = upNextCardState.draftAdded ? [draftPrompt] : []
    const view = {
      ...base,
      conversationId: { kind: 'card' as const, taskId: 'btk_1234' },
      blocks,
      draftCount: blocks.length
    }
    if (method === UP_NEXT_RPC.list) {
      return { view }
    }
    if (method === UP_NEXT_RPC.append) {
      upNextCardState.draftAdded = true
      return { view: { ...view, blocks: [draftPrompt], draftCount: 1 } }
    }
    if (method === UP_NEXT_RPC.commit) {
      throw new Error('upNext.refusal.subjectNotStarted')
    }
    throw new Error('upNext.refusal.subjectNotStarted')
  })
}))
vi.mock('@/components/handoffs/handoff-client', () => ({
  handoffApi: () => api,
  capturePickedHandoffFile: vi.fn(),
  downloadHandoffVersion: vi.fn()
}))

// Why: Needs You lists people's handoffs only, so the fixture card is one the hub tied to a thread.
const item = {
  task_id: 'btk_1234',
  title: 'Ship completion',
  state_revision: 3,
  primary_action: { handoff_thread_id: 'hth_item' }
}
const listTodo = vi.fn()
const completeTask = vi.fn()
const getTask = vi.fn()
const MISSING = 'That work is not in your lists here.'

beforeEach(() => {
  localStorage.clear()
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
  useBackofficeWorkFocus.setState({ request: null, missing: null })
  // Why: rows come from the shared work store, which reads the Todo through the preload bridge.
  listTodo.mockResolvedValue({
    ok: true,
    baseUrl: 'https://omnios.example.com',
    employeeId: 'emp_sal',
    generatedAt: null,
    items: [item],
    awaitingVerification: [],
    counts: null,
    truncated: false
  })
  api.list.mockImplementation(async (args: { view?: string } = {}) => ({
    ok: true,
    data: { assignee: 'emp_sal', threads: [], next_cursor: null, ...args }
  }))
  api.recipients.mockResolvedValue({ ok: true, data: { employees: [] } })
  api.get.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'no thread' } })
  completeTask.mockResolvedValue({ ok: true })
  getTask.mockResolvedValue({
    ok: false,
    error: { code: 'forbidden', message: 'Card access denied' }
  })
  Object.assign(window, {
    api: {
      preflight: {
        detectAgents: vi.fn().mockResolvedValue([])
      },
      backoffice: {
        listTodo,
        completeTask,
        feed: vi.fn().mockResolvedValue({ ok: true, body: { projects: [] } })
      },
      consoleWorkflows: {
        getTask,
        listHumanActions: vi.fn().mockResolvedValue({ ok: true, data: { jobs: [] } })
      }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useWaitLater.getState().setUntil(waitLaterKeyForCard('btk_1234'), null)
  upNextCardState.draftAdded = false
  upNextCardState.calls = []
})

function renderHost(overrides: Partial<BackofficeTodoListHostProps> = {}) {
  return render(
    <TooltipProvider>
      <BackofficeTodoListHost
        state={{
          phase: 'ready',
          items: [item],
          baseUrl: 'https://omnios.example.com',
          employeeId: 'emp_sal',
          generatedAt: null
        }}
        onRefresh={vi.fn()}
        onUseItem={vi.fn()}
        onArchiveItem={vi.fn()}
        archivePending={null}
        onOpenOffice={vi.fn()}
        {...overrides}
      />
    </TooltipProvider>
  )
}

function currentScope(): string {
  return renderHook(() => useHandoffScope()).result.current
}

describe('BackofficeTodoListHost completion action', () => {
  it('keeps live card drafts and direct revision-checked completion beside archive', async () => {
    const onArchiveItem = vi.fn()
    renderHost({ onArchiveItem })

    expect(await screen.findByRole('heading', { name: 'Up next' })).toBeTruthy()
    const addBar = document.querySelector('[data-up-next-add]')
    expect(addBar).toBeTruthy()
    const addButtons = within(addBar as HTMLElement).getAllByRole('button')
    expect(addButtons.length).toBeGreaterThan(0)
    for (const button of addButtons) {
      expect(button.hasAttribute('disabled')).toBe(false)
    }

    const chainSection = document.querySelector('[data-up-next-chain]') as HTMLElement
    fireEvent.click(within(addBar as HTMLElement).getByRole('button', { name: '+ Prompt' }))
    const commitButton = await within(chainSection).findByRole('button', {
      name: /Send now|Queue \d+ new blocks/
    })
    fireEvent.click(commitButton)

    await waitFor(() => expect(within(chainSection).getByRole('alert')).toBeTruthy())
    expect(completeTask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }))
    await waitFor(() => expect(completeTask).toHaveBeenCalled())
    expect(completeTask.mock.calls[0]?.[0]).toMatchObject({ taskId: item.task_id })
    expect(onArchiveItem).not.toHaveBeenCalled()
  })
})

describe('BackofficeTodoListHost Todo pages', () => {
  it('offers the next page of tasks and appends it on request', async () => {
    const more = {
      task_id: 'btk_5678',
      title: 'Second page card',
      state_revision: 1,
      primary_action: { handoff_thread_id: 'hth_more' }
    }
    const page = (items: object[], nextCursor: string | null) => ({
      ok: true,
      baseUrl: 'https://omnios.example.com',
      employeeId: 'emp_sal',
      generatedAt: null,
      items,
      awaitingVerification: [],
      counts: null,
      nextCursor,
      truncated: nextCursor !== null
    })
    // Why: the store follows four pages on its own; the fifth stays behind "Load more tasks".
    listTodo.mockImplementation(async (args?: { cursor?: string }) => {
      const index = args?.cursor ? Number(args.cursor.replace('page_', '')) : 0
      return index < 4 ? page([item], `page_${index + 1}`) : page([more], null)
    })
    renderHost()
    expect(await screen.findByRole('button', { name: /^Ship completion/ })).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Load more tasks' }))
    expect(await screen.findByRole('button', { name: /^Second page card/ })).toBeTruthy()
    expect(listTodo).toHaveBeenCalledWith({ cursor: 'page_4' })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load more tasks' })).toBeNull()
    )
  })

  it('reads no finished history for the default Needs You list', async () => {
    renderHost()
    await screen.findByRole('button', { name: /^Ship completion/ })
    expect(api.list.mock.calls.some(([args]) => args?.state === 'resolved')).toBe(false)
  })
})

describe('BackofficeTodoListHost focus requests', () => {
  it('says so when the focused task is not in the loaded lists', async () => {
    useBackofficeWorkFocus.getState().focus({ scope: currentScope(), taskId: 'btk_gone' })
    renderHost()
    expect(await screen.findByText(MISSING)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /^Ship completion/ }).getAttribute('aria-current')
    ).toBe('true')
  })

  it('waits for the first answer before deciding a focused task is missing', async () => {
    useBackofficeWorkFocus.getState().focus({ scope: currentScope(), taskId: 'btk_1234' })
    renderHost()
    await screen.findByRole('heading', { name: 'Up next' })
    await waitFor(() => expect(useBackofficeWorkFocus.getState().request).toBeNull())
    expect(useBackofficeWorkFocus.getState().missing).toBeNull()
    expect(screen.queryByText(MISSING)).toBeNull()
  })

  it('ignores a focus request made under another scope', async () => {
    useBackofficeWorkFocus.getState().focus({ scope: 'another-account', taskId: 'btk_gone' })
    renderHost()
    await screen.findByRole('heading', { name: 'Up next' })
    expect(useBackofficeWorkFocus.getState()).toMatchObject({ request: null, missing: null })
    expect(screen.queryByText(MISSING)).toBeNull()
  })
})

describe('BackofficeTodoListHost search and source', () => {
  const resolvedThread = {
    id: 'hth_old',
    board_task_id: 'btk_9999',
    author_employee_id: 'emp_gamma',
    recipient_employee_id: 'emp_sal',
    title: 'Last quarter deck',
    state: 'resolved',
    action: 'review',
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: '2026-08-01T09:00:00Z',
    files: [],
    reviews: []
  }

  it('narrows Needs You by the search without leaving the tab', async () => {
    listTodo.mockResolvedValue({
      ok: true,
      baseUrl: 'https://omnios.example.com',
      employeeId: 'emp_sal',
      generatedAt: null,
      items: [
        item,
        {
          task_id: 'btk_5678',
          title: 'Write the brief',
          state_revision: 1,
          primary_action: { handoff_thread_id: 'hth_brief' }
        }
      ],
      awaitingVerification: [],
      counts: null,
      truncated: false
    })
    renderHost()
    expect(await screen.findByRole('button', { name: /^Write the brief/ })).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search work' }), {
      target: { value: 'ship' }
    })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Write the brief/ })).toBeNull()
    )
    expect(screen.getByRole('button', { name: /^Ship completion/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Needs You' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search work' }), {
      target: { value: 'nothing here' }
    })
    expect(await screen.findByText('No work matches this search.')).toBeTruthy()
  })

  it('finds a resolved request by title on All', async () => {
    api.list.mockImplementation(async (args: { view?: string; state?: string } = {}) => ({
      ok: true,
      data: {
        assignee: 'emp_sal',
        threads: args.state === 'resolved' ? [resolvedThread] : [],
        next_cursor: null,
        ...(args.view ? { view: args.view } : {})
      }
    }))
    renderHost()
    expect(await screen.findByRole('button', { name: /^Ship completion/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search work' }), {
      target: { value: 'quarter' }
    })
    expect(await screen.findByRole('button', { name: /^Last quarter deck/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Ship completion/ })).toBeNull()
  })
})

describe('BackofficeTodoListHost one list', () => {
  const thread = {
    id: 'hth_deep',
    board_task_id: 'btk_9999',
    author_employee_id: 'emp_gamma',
    recipient_employee_id: 'emp_sal',
    title: 'Deck to review',
    state: 'open',
    action: 'review',
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: '2026-09-11T09:00:00Z',
    files: [],
    reviews: []
  }

  it('sorts a decision above a plain task under Needs You', async () => {
    listTodo.mockResolvedValue({
      ok: true,
      baseUrl: 'https://omnios.example.com',
      employeeId: 'emp_sal',
      generatedAt: null,
      items: [
        {
          task_id: 'btk_plain',
          title: 'Plain task',
          updated_at: '2026-09-11T12:00:00Z',
          primary_action: { handoff_thread_id: 'hth_plain' }
        },
        {
          task_id: 'btk_dec1',
          title: 'Decide pricing',
          kind: 'decision',
          updated_at: '2026-09-11T10:00:00Z',
          primary_action: { handoff_thread_id: 'hth_dec1' }
        }
      ],
      awaitingVerification: [],
      counts: null,
      truncated: false
    })
    renderHost()
    await screen.findByRole('button', { name: /^Plain task/ })
    const keys = [...document.querySelectorAll('[data-work-row]')].map((row) =>
      row.getAttribute('data-work-row')
    )
    expect(keys[0]).toBe('todo:btk_dec1:::task')
    expect(keys[1]).toBe('todo:btk_plain:::task')
  })

  it('keeps a put-away row out of Needs You and out of All + needs-you, but in All', async () => {
    useWaitLater
      .getState()
      .setUntil(waitLaterKeyForCard('btk_1234'), new Date(Date.now() + 60 * 60 * 1000))
    renderHost()
    expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Needs You' }).textContent).toContain('0')
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(await screen.findByRole('button', { name: /^Ship completion/ })).toBeTruthy()
    cleanup()
    localStorage.setItem(
      `backoffice-work-selection-v2:${currentScope()}`,
      JSON.stringify({
        lens: 'all',
        rowKey: null,
        filter: { person: 'all', status: 'needs-you', project: 'all', source: 'all', query: '' }
      })
    )
    renderHost()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(await screen.findByText('No work matches this view.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Ship completion/ })).toBeNull()
  })

  it("lands on the waiting lens when Attention's count asks for it", async () => {
    useBackofficeWorkFocus.getState().focus({ scope: currentScope(), lens: 'waiting' })
    renderHost()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Waiting For' }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    )
    expect(screen.getByRole('button', { name: 'Needs You' }).getAttribute('aria-pressed')).toBe(
      'false'
    )
  })

  it('selects a handoff thread that a deep link names', async () => {
    api.list.mockImplementation(async (args: { view?: string; state?: string } = {}) => ({
      ok: true,
      data: {
        assignee: 'emp_sal',
        threads: args.view || args.state ? [] : [thread],
        next_cursor: null,
        ...(args.view ? { view: args.view } : {})
      }
    }))
    useBackofficeWorkFocus.getState().focus({ scope: currentScope(), threadId: 'hth_deep' })
    renderHost()
    await waitFor(() =>
      expect(
        document.querySelector('[data-work-row="handoff:hth_deep"]')?.getAttribute('aria-current')
      ).toBe('true')
    )
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
    expect(useBackofficeWorkFocus.getState()).toMatchObject({ request: null, missing: null })
  })

  it('marks a request read only once the person chooses it here, never from a remembered row', async () => {
    api.list.mockImplementation(async (args: { view?: string; state?: string } = {}) => ({
      ok: true,
      data: {
        assignee: 'emp_sal',
        threads: args.view || args.state ? [] : [thread],
        next_cursor: null,
        ...(args.view ? { view: args.view } : {})
      }
    }))
    const detail = { ok: true, data: { thread, files: [], reviews: [], entries: [] } }
    api.get.mockResolvedValue(detail)
    api.markRead.mockResolvedValue(detail)
    // Why: yesterday's choice is remembered; a reply that arrived since must not be read unseen.
    localStorage.setItem(
      `backoffice-work-selection-v2:${currentScope()}`,
      JSON.stringify({
        lens: 'all',
        rowKey: 'handoff:hth_deep',
        filter: { person: 'all', status: 'all', project: 'all', source: 'all', query: '' }
      })
    )
    renderHost()
    await waitFor(() =>
      expect(
        document.querySelector('[data-work-row="handoff:hth_deep"]')?.getAttribute('aria-current')
      ).toBe('true')
    )
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(api.markRead).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Deck to review/ }))
    await waitFor(() => expect(api.markRead).toHaveBeenCalledWith({ threadId: 'hth_deep' }))
  })

  it("counts the same rows on Attention's summary and on the lenses, from one store", async () => {
    const sent = {
      ...thread,
      id: 'hth_sent',
      author_employee_id: 'emp_sal',
      recipient_employee_id: 'emp_iris',
      title: 'Notes to Iris'
    }
    api.list.mockImplementation(async (args: { view?: string; state?: string } = {}) => ({
      ok: true,
      data: {
        assignee: 'emp_sal',
        threads: args.view === 'sent' ? [sent] : args.view || args.state ? [] : [thread],
        next_cursor: null,
        ...(args.view ? { view: args.view } : {})
      }
    }))
    render(
      <TooltipProvider>
        <AttentionWorkSummary />
      </TooltipProvider>
    )
    renderHost()
    // Why: the card and the received request need this person; the sent request waits on Iris.
    expect(await screen.findByRole('button', { name: '2 need you' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '1 waiting' })).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Needs You' }).textContent).toContain('2')
    )
    expect(screen.getByRole('button', { name: 'Waiting For' }).textContent).toContain('1')
  })

  it("reads a thread's card by id in place and preserves a permission refusal", async () => {
    const orphan = {
      id: 'hth_card',
      board_task_id: 'btk_gone',
      author_employee_id: 'emp_gamma',
      recipient_employee_id: 'emp_sal',
      title: 'Card elsewhere',
      state: 'open',
      action: 'review',
      due_at: null,
      parent_thread_id: null,
      delivery_id: null,
      updated: '2026-09-11T09:00:00Z',
      files: [],
      reviews: []
    }
    api.list.mockImplementation(async (args: { view?: string; state?: string } = {}) => ({
      ok: true,
      data: {
        assignee: 'emp_sal',
        threads: args.view || args.state ? [] : [orphan],
        next_cursor: null,
        ...(args.view ? { view: args.view } : {})
      }
    }))
    const detail = { ok: true, data: { thread: orphan, files: [], reviews: [], entries: [] } }
    api.get.mockResolvedValue(detail)
    api.markRead.mockResolvedValue(detail)
    renderHost()
    fireEvent.click(await screen.findByRole('button', { name: /^Card elsewhere/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open task' }))
    expect(await screen.findByText('Could not read this card: Card access denied')).toBeTruthy()
    expect(getTask).toHaveBeenCalledWith({ taskId: 'btk_gone' })
    expect(document.querySelector('[data-card-error]')).not.toBeNull()
    expect(document.querySelector('[data-work-focus-missing="btk_gone"]')).toBeNull()
  })

  it('says so when a deep link names a thread the lists do not hold', async () => {
    useBackofficeWorkFocus.getState().focus({ scope: currentScope(), threadId: 'hth_gone' })
    renderHost()
    expect(await screen.findByText(MISSING)).toBeTruthy()
    expect(document.querySelector('[data-work-focus-missing="hth_gone"]')).not.toBeNull()
  })
})

it('opens Needs You despite an old All selection and places Kanban immediately after Waiting For', async () => {
  localStorage.setItem(
    `backoffice-work-selection-v2:${currentScope()}`,
    JSON.stringify({ lens: 'all', rowKey: null })
  )
  renderHost()
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Needs You' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
  )
  const nav = screen.getByRole('navigation', { name: 'Work lenses' })
  expect(
    [...nav.querySelectorAll('button')].map(
      (button) => button.getAttribute('aria-label') ?? button.textContent
    )
  ).toEqual(['Needs You', 'Waiting For', 'Kanban', 'All'])
  fireEvent.click(screen.getByRole('button', { name: 'Waiting For' }))
  expect(screen.getByRole('button', { name: 'Waiting For' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
})

it('opens task details on Kanban and preserves the board filters and scroll when closed', async () => {
  const card = {
    id: 'btk_1234',
    title: 'Ship completion',
    status: 'in_progress',
    source: 'omniconsole-ide',
    company_slug: 'alpha',
    org_unit_id: 'org_dev',
    owner_employee_id: 'emp_sal',
    state_revision: 3
  }
  Object.assign(window.api.consoleWorkflows, {
    listWork: vi.fn().mockResolvedValue({
      ok: true,
      data: { items: [card], total: 1, capped: false }
    })
  })
  getTask.mockResolvedValue({ ok: true, data: card })
  const { container } = renderHost()
  fireEvent.click(await screen.findByRole('button', { name: 'Kanban' }))
  const board = await screen.findByRole('region', { name: 'Work board' })
  await within(board).findByText('Ship completion')
  fireEvent.change(within(board).getByLabelText('Company'), { target: { value: 'alpha' } })
  fireEvent.change(within(board).getByLabelText('Search Work'), { target: { value: 'ship' } })
  const scroller = board.parentElement as HTMLElement
  scroller.scrollTop = 180
  fireEvent.click(within(board).getByText('Ship completion'))
  const detail = await screen.findByRole('dialog', { name: 'Task details' })
  expect(within(detail).getByRole('button', { name: 'Edit task' })).toBeTruthy()
  expect(container.querySelector('[aria-label="Work board"]')).toBe(board)
  fireEvent.click(within(detail).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Task details' })).toBeNull())
  expect(screen.getByRole('region', { name: 'Work board' })).toBe(board)
  expect((within(board).getByLabelText('Company') as HTMLSelectElement).value).toBe('alpha')
  expect((within(board).getByLabelText('Search Work') as HTMLInputElement).value).toBe('ship')
  expect(scroller.scrollTop).toBe(180)
})
