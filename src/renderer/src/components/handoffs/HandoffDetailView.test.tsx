// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HandoffDetailView } from './HandoffDetailView'
import { resetHandoffPeopleReads } from '@/components/next-step/use-handoff-people'

const api = vi.hoisted(() => ({
  get: vi.fn(),
  markRead: vi.fn(),
  bindThread: vi.fn(),
  recipients: vi.fn()
}))
vi.mock('./handoff-client', () => ({
  handoffApi: () => api,
  capturePickedHandoffFile: vi.fn(),
  downloadHandoffVersion: vi.fn()
}))
const workflowApi = vi.hoisted(() => ({ listWork: vi.fn() }))
vi.mock('@/lib/console-workflow-client', () => ({
  consoleWorkflowApi: () => workflowApi,
  workflowData: (result: { ok: boolean; data?: unknown; error?: { message: string } }) => {
    if (!result.ok) {
      throw new Error(result.error?.message ?? 'failed')
    }
    return result.data
  },
  workflowErrorMessage: (reason: unknown) =>
    reason instanceof Error ? reason.message : String(reason)
}))
vi.mock('./HandoffReviewPanel', () => ({
  HandoffReviewPanel: ({ onChanged }: { onChanged: () => void }) => (
    <button type="button" onClick={onChanged}>
      Save review
    </button>
  )
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en' }
}))
const openModal = vi.hoisted(() => vi.fn())
const openUrl = vi.fn()
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({
      settings: {
        backofficeEnv: 'production',
        backofficeProductionUrl: 'https://omnios.example.com'
      },
      openModal
    })
}))

const detail = {
  thread: {
    id: 'hth_one',
    board_task_id: 'btk_one1',
    author_employee_id: 'emp_gamma',
    recipient_employee_id: 'emp_sal',
    title: 'Review',
    state: 'open',
    action: 'review',
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: '2026-09-11T09:00:00Z'
  },
  files: [],
  reviews: [],
  entries: []
}

function renderView(onChanged: (change: string) => void, markRead?: boolean) {
  return render(
    <TooltipProvider>
      <HandoffDetailView
        scope="scope-a"
        threadId="hth_one"
        markRead={markRead}
        onOpenTask={vi.fn()}
        onChanged={onChanged}
      />
    </TooltipProvider>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(window, 'api', {
    value: { shell: { openUrl } },
    configurable: true
  })
  resetHandoffPeopleReads()
  api.recipients.mockResolvedValue({ ok: true, data: { employees: [] } })
  api.get.mockResolvedValue({ ok: true, data: detail })
})

afterEach(cleanup)

describe('HandoffDetailView changes', () => {
  it('reports a successful read on open', async () => {
    api.markRead.mockResolvedValue({ ok: true, data: detail })
    const onChanged = vi.fn()
    renderView(onChanged)
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('read'))
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('reports nothing when marking the thread read fails', async () => {
    api.markRead.mockResolvedValue({
      ok: false,
      error: { code: 'backoffice_refused', message: 'refused' }
    })
    const onChanged = vi.fn()
    renderView(onChanged)
    await screen.findByText('refused')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('reports nothing for a read that lands after the view closed', async () => {
    let finishRead: (value: unknown) => void = () => undefined
    api.markRead.mockReturnValue(
      new Promise((resolve) => {
        finishRead = resolve
      })
    )
    const onChanged = vi.fn()
    const view = renderView(onChanged)
    await waitFor(() => expect(api.markRead).toHaveBeenCalled())
    view.unmount()
    finishRead({ ok: true, data: detail })
    await Promise.resolve()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('reports a review, return or forward as an update', async () => {
    api.markRead.mockResolvedValue({ ok: true, data: detail })
    const onChanged = vi.fn()
    renderView(onChanged)
    fireEvent.click(await screen.findByRole('button', { name: 'Save review' }))
    expect(onChanged).toHaveBeenCalledWith('updated')
  })

  it('leaves a thread it only shows by default unread', async () => {
    const onChanged = vi.fn()
    renderView(onChanged, false)
    await screen.findByRole('button', { name: 'Save review' })
    expect(api.markRead).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe('HandoffDetailView open task', () => {
  it('hands Open task to the caller and opens no other page', async () => {
    const onOpenTask = vi.fn()
    render(
      <TooltipProvider>
        <HandoffDetailView scope="scope-a" threadId="hth_one" onOpenTask={onOpenTask} />
      </TooltipProvider>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Open task' }))
    expect(onOpenTask).toHaveBeenCalledExactlyOnceWith('btk_one1')
  })
})

describe('HandoffDetailView launch', () => {
  it('mounts review actions without Up next for the recipient', async () => {
    render(
      <TooltipProvider>
        <HandoffDetailView
          scope="scope-a"
          threadId="hth_one"
          viewer="emp_sal"
          onOpenTask={vi.fn()}
        />
      </TooltipProvider>
    )
    expect(await screen.findByText('Open task')).toBeTruthy()
    expect(document.querySelector('[data-up-next-chain]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Looks good, continue' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start with my AI' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Give to (AI|Person)/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start with my AI in a project' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy()
    expect(openModal).not.toHaveBeenCalled()
  })
})

describe('HandoffDetailView without a card', () => {
  it('hides the task door and says the request stands on its own', async () => {
    api.get.mockResolvedValue({
      ok: true,
      data: { ...detail, thread: { ...detail.thread, board_task_id: null } }
    })
    api.markRead.mockResolvedValue({
      ok: true,
      data: { ...detail, thread: { ...detail.thread, board_task_id: null } }
    })
    renderView(vi.fn())
    expect(await screen.findByText('open')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open task' })).toBeNull()
    expect(screen.getByText('Not on a task; it is the request itself.')).toBeTruthy()
    expect(screen.queryByText(/^Task /)).toBeNull()
  })

  it('Open task hands the card id to the caller instead of the workflow Jobs view', async () => {
    const onOpenTask = vi.fn()
    render(
      <TooltipProvider>
        <HandoffDetailView
          scope="scope-a"
          threadId="hth_one"
          viewer="emp_gamma"
          onOpenTask={onOpenTask}
        />
      </TooltipProvider>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Open task' }))
    expect(onOpenTask).toHaveBeenCalledWith('btk_one1')
  })

  it('opens Jira attachment on the shared conversation without binding a legacy card', async () => {
    api.get.mockResolvedValue({
      ok: true,
      data: { ...detail, thread: { ...detail.thread, board_task_id: null } }
    })
    api.markRead.mockResolvedValue({
      ok: true,
      data: { ...detail, thread: { ...detail.thread, board_task_id: null } }
    })
    const onOpenTask = vi.fn()
    const onChanged = vi.fn()
    render(
      <TooltipProvider>
        <HandoffDetailView
          scope="scope-a"
          threadId="hth_one"
          onOpenTask={onOpenTask}
          onChanged={onChanged}
        />
      </TooltipProvider>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Attach an existing Jira task…' }))
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(
      'https://omnios.example.com/work/handoffs/hth_one'
    )
    expect(api.bindThread).not.toHaveBeenCalled()
    expect(workflowApi.listWork).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalledWith('updated')
    expect(onOpenTask).not.toHaveBeenCalled()
  })

  it('keeps ordinary communication free of task attachment controls', async () => {
    api.get.mockResolvedValue({
      ok: true,
      data: {
        ...detail,
        thread: { ...detail.thread, board_task_id: null, communication_type: 'fyi' }
      }
    })
    api.markRead.mockResolvedValue({
      ok: true,
      data: {
        ...detail,
        thread: { ...detail.thread, board_task_id: null, communication_type: 'fyi' }
      }
    })
    renderView(vi.fn())
    await screen.findByText('open')
    expect(screen.queryByRole('button', { name: 'Attach an existing Jira task…' })).toBeNull()
  })
})

it('keeps proposal replies and AI assistance separate from the tracking decision', async () => {
  api.get.mockResolvedValue({
    ok: true,
    data: {
      ...detail,
      thread: { ...detail.thread, board_task_id: null },
      task_proposal: {
        company_id: 'co_omr',
        commitment_anchor: 'outcome:launch',
        proposed_commitment: 'Ship launch',
        triage_owner: 'emp_sal',
        next_check_at: '2026-09-21T16:00:00Z',
        decision: 'pending',
        creates_task: false,
        decision_id: 'dcn_proposal'
      }
    }
  })
  render(
    <TooltipProvider>
      <HandoffDetailView scope="scope-a" threadId="hth_one" viewer="emp_sal" markRead={false} />
    </TooltipProvider>
  )
  expect(await screen.findByText('Ship launch')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Start with my AI' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Looks good, continue' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Save review' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Open conversation and tracking decision' }))
  expect(openUrl).toHaveBeenCalledWith('https://omnios.example.com/work/handoffs/hth_one')
})
