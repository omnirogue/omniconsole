// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkRow } from '../../../../../shared/backoffice-work-views'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as WorkflowClient from '@/lib/console-workflow-client'
import { BackofficeWorkDetail } from './backoffice-work-detail'
import { useBackofficeWorkFocus } from './backoffice-work-selection'

// These cover the hand composer itself, which ships behind a flag that is off.
vi.mock('@/components/next-action/up-next-composer-flag', () => ({
  UP_NEXT_COMPOSER_ENABLED: true
}))

const invalidate = vi.hoisted(() => vi.fn())
const storeState = vi.hoisted(() => ({ todo: { phase: 'idle' } as Record<string, unknown> }))
vi.mock('./backoffice-work-store', () => ({
  invalidateBackofficeWork: invalidate,
  useBackofficeWorkStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(storeState)
}))
vi.mock('@/components/handoffs/HandoffDetailView', () => ({
  HandoffDetailView: ({
    onChanged,
    markRead
  }: {
    onChanged?: (change: 'read' | 'updated') => void
    markRead?: boolean
  }) => (
    <>
      <span data-mark-read={String(markRead)} />
      <button type="button" onClick={() => onChanged?.('read')}>
        Read
      </button>
      <button type="button" onClick={() => onChanged?.('updated')}>
        Update
      </button>
    </>
  )
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en' }
}))
const bindThread = vi.hoisted(() => vi.fn())
vi.mock('@/components/handoffs/handoff-client', () => ({ handoffApi: () => ({ bindThread }) }))
const decide = vi.hoisted(() => vi.fn())
vi.mock('@/lib/console-workflow-client', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkflowClient>()
  return { ...actual, consoleWorkflowApi: () => ({ decideHumanAction: decide }) }
})

function jobRow(canDecide = true): WorkRow {
  return {
    key: 'job:job_stage',
    source: 'human-job',
    taskId: 'btk_one1',
    title: 'Approve the plan',
    kind: 'approval',
    nextActor: canDecide ? { kind: 'me' } : { kind: 'run', thenIds: [] },
    why: null,
    what: null,
    actionLabel: 'approve',
    state: 'awaiting_human',
    dueAt: null,
    updatedAt: null,
    repliesWaiting: 0,
    needsYou: canDecide,
    waitingFor: !canDecide,
    job: {
      id: 'job_stage',
      task_id: 'btk_one1',
      node_id: null,
      title: 'Approve the plan',
      status: 'queued',
      actor_type: 'human',
      provider: null,
      model: null,
      effort: null,
      repo: null,
      machine: null,
      pr_url: null,
      attempt: 1,
      lease_generation: 1,
      owned_paths: null,
      updated_at: null,
      policy: {
        workflow: {
          version: 1,
          digest: 'a'.repeat(64),
          mode: 'hybrid',
          dispatch_id: 'wf_1',
          key: 'approve',
          actor_type: 'human',
          actor_id: 'emp_sal',
          action: 'approve',
          after: [],
          after_keys: [],
          require_merged: [],
          approval_ancestors: []
        }
      },
      blockers: [],
      workflow_state: 'awaiting_human',
      can_decide: canDecide
    }
  }
}

function threadRow(repliesWaiting: number): WorkRow {
  return {
    key: 'handoff:hth_one',
    source: 'sent-handoff',
    taskId: 'btk_one1',
    title: 'Review',
    kind: 'reply',
    nextActor: { kind: 'me' },
    why: null,
    what: null,
    actionLabel: 'review',
    state: 'replied',
    dueAt: null,
    updatedAt: null,
    repliesWaiting,
    needsYou: true,
    waitingFor: false,
    thread: {
      id: 'hth_one',
      board_task_id: 'btk_one1',
      author_employee_id: 'emp_sal',
      recipient_employee_id: 'emp_iris',
      title: 'Review',
      state: 'replied',
      action: 'review',
      due_at: null,
      parent_thread_id: null,
      delivery_id: null,
      updated: '2026-09-11T09:00:00Z',
      files: [],
      reviews: []
    }
  }
}

function renderDetail(row: WorkRow, markRead = true) {
  const onKeepRow = vi.fn()
  render(
    <TooltipProvider>
      <BackofficeWorkDetail
        row={row}
        scope="scope-a"
        baseUrl={null}
        names={new Map()}
        itemActions={{ onUseItem: vi.fn(), onArchiveItem: vi.fn(), archivePending: null }}
        onOpenTask={vi.fn()}
        onKeepRow={onKeepRow}
        markRead={markRead}
      />
    </TooltipProvider>
  )
  return onKeepRow
}

function todoRow(taskId: string): WorkRow {
  const row = threadRow(0)
  return {
    ...row,
    key: `todo:${taskId}`,
    source: 'task',
    taskId,
    todo: { task_id: taskId, title: row.title }
  }
}

afterEach(() => {
  cleanup()
  invalidate.mockClear()
  decide.mockReset()
  storeState.todo = { phase: 'idle' }
})

function messageRow(taskId: string | null): WorkRow {
  return {
    key: 'message:msg_1',
    source: 'message',
    taskId,
    title: 'Which deck should I use?',
    kind: 'reply',
    nextActor: { kind: 'me' },
    why: null,
    what: null,
    actionLabel: 'question',
    state: 'delivered',
    dueAt: null,
    updatedAt: null,
    repliesWaiting: 0,
    needsYou: true,
    waitingFor: false,
    direction: 'received',
    message: {
      id: 'msg_1',
      project_id: 'prj_shared',
      task_id: taskId,
      sender_session_id: 'sess_gamma',
      recipient_session_id: 'sess_sal',
      sender_employee_id: 'emp_gamma',
      recipient_employee_id: 'emp_sal',
      purpose: 'question',
      summary: 'Which deck should I use?\nThe Q3 one or the board one?',
      state: 'delivered',
      created_at: 1_789_200_000,
      delivered_at: 1_789_200_060,
      replied_at: null,
      resolved_at: null,
      expires_at: null,
      reply: null
    }
  }
}

describe('BackofficeWorkDetail on a peer message', () => {
  it('shows the message without retired manual state controls and points at the Console', () => {
    renderDetail(messageRow(null))
    expect(screen.getByText(/The Q3 one or the board one/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Snooze' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Wait' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add Next' })).toBeNull()
    expect(screen.getByText(/The answer goes through the Console/)).toBeTruthy()
  })

  it('offers the Up next composer on the message’s card once Tasks holds that card', () => {
    storeState.todo = {
      phase: 'ready',
      value: { items: [{ task_id: 'btk_one1', title: 'Deck', state_revision: 1 }] }
    }
    renderDetail(messageRow('btk_one1'))
    expect(screen.getByRole('button', { name: 'Up next' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open its card' })).toBeTruthy()
    expect(screen.queryByText(/The answer goes through the Console/)).toBeNull()
  })
})

describe('BackofficeWorkDetail changes', () => {
  it('keeps a row with unread replies open and re-reads the lists once it is read', () => {
    const onKeepRow = renderDetail(threadRow(1))
    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    expect(onKeepRow).toHaveBeenCalledWith('handoff:hth_one')
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('does not re-read when opening a request with nothing unread', () => {
    const onKeepRow = renderDetail(threadRow(0))
    fireEvent.click(screen.getByRole('button', { name: 'Read' }))
    expect(onKeepRow).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('re-reads the lists after a review, return or forward', () => {
    const onKeepRow = renderDetail(threadRow(0))
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(onKeepRow).not.toHaveBeenCalled()
  })

  it('passes on whether the person chose the request, so a default row stays unread', () => {
    renderDetail(threadRow(1), false)
    expect(document.querySelector('[data-mark-read="false"]')).not.toBeNull()
    cleanup()
    renderDetail(threadRow(1))
    expect(document.querySelector('[data-mark-read="true"]')).not.toBeNull()
  })
})

describe('BackofficeWorkDetail on a workflow stage assigned to me', () => {
  it('shows the evidence form instead of the shared Done control', async () => {
    decide.mockResolvedValue({ ok: true, data: { job: jobRow().job } })
    const onKeepRow = renderDetail(jobRow())
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Decision note'), { target: { value: 'Looks right' } })
    expect(approve.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Evidence reference or result'), {
      target: { value: 'plan.md reviewed' }
    })
    expect(approve.hasAttribute('disabled')).toBe(false)
    fireEvent.click(approve)
    await waitFor(() =>
      expect(decide).toHaveBeenCalledExactlyOnceWith({
        jobId: 'job_stage',
        decision: 'approve',
        note: 'Looks right\nEvidence: plan.md reviewed'
      })
    )
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1))
    expect(onKeepRow).toHaveBeenCalledWith('job:job_stage')
  })

  it("opens the stage's card by focusing its row, never a second page", () => {
    useBackofficeWorkFocus.setState({ request: null, missing: null })
    renderDetail(jobRow())
    fireEvent.click(screen.getByRole('button', { name: 'Open card' }))
    expect(useBackofficeWorkFocus.getState().request).toMatchObject({
      scope: 'scope-a',
      taskId: 'btk_one1'
    })
  })

  it('offers no decision while the run still holds the stage', () => {
    renderDetail(jobRow(false))
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
    expect(
      screen.getByText('The server has not made this job available for your decision.')
    ).toBeTruthy()
  })
})

describe('BackofficeWorkDetail on a request without a card', () => {
  it('keeps one next-action editor while switching between task rows', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const props = {
      scope: 'scope-a',
      baseUrl: null,
      names: new Map<string, string>(),
      itemActions: { onUseItem: vi.fn(), onArchiveItem: vi.fn(), archivePending: null },
      onOpenTask: vi.fn(),
      onKeepRow: vi.fn(),
      markRead: true
    }
    const view = render(
      <TooltipProvider>
        <BackofficeWorkDetail {...props} row={todoRow('btk_one1')} />
      </TooltipProvider>
    )
    view.rerender(
      <TooltipProvider>
        <BackofficeWorkDetail {...props} row={todoRow('btk_two2')} />
      </TooltipProvider>
    )
    expect(document.querySelectorAll('[data-work-next-action]')).toHaveLength(1)
    expect(
      document.querySelector('[data-work-next-action]')?.getAttribute('data-work-next-action')
    ).toBe('btk_two2')
    expect(errors.mock.calls.flat().join(' ')).not.toContain('same key')
    errors.mockRestore()
  })

  it('keeps a cardless Handoff independent without offering legacy task creation', () => {
    const createTask = vi.fn()
    Object.assign(window, { api: { backoffice: { createTask } } })
    bindThread.mockClear()
    const row = threadRow(0)
    renderDetail({ ...row, taskId: null, thread: { ...row.thread!, board_task_id: null } })
    expect(screen.queryByRole('button', { name: 'Make this a task' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Read' })).toBeTruthy()
    expect(createTask).not.toHaveBeenCalled()
    expect(bindThread).not.toHaveBeenCalled()
  })

  it('does not offer it on a request that already has a card', () => {
    renderDetail(threadRow(0))
    expect(screen.queryByRole('button', { name: 'Make this a task' })).toBeNull()
  })

  it("does not offer it on a card's own row that carries a card-less thread", () => {
    const row = threadRow(0)
    renderDetail({
      ...row,
      key: 'todo:btk_one',
      source: 'task',
      taskId: 'btk_one',
      todo: { task_id: 'btk_one', title: row.title },
      thread: { ...row.thread!, board_task_id: null }
    })
    expect(screen.queryByRole('button', { name: 'Make this a task' })).toBeNull()
  })
})

describe('BackofficeWorkDetail read-only card', () => {
  const cardRow: WorkRow = {
    key: 'card:btk_one1',
    source: 'task',
    taskId: 'btk_one1',
    title: 'Check ide',
    kind: 'work',
    nextActor: { kind: 'person', id: 'emp_uma' },
    why: null,
    what: 'Claim it',
    actionLabel: null,
    state: 'open',
    dueAt: '2026-09-12T18:00+00:00',
    updatedAt: null,
    repliesWaiting: 0,
    needsYou: false,
    waitingFor: false,
    card: {
      id: 'btk_one1',
      title: 'Check ide',
      status: 'open',
      owner_employee_id: 'emp_uma',
      acceptance_criteria: 'sidebar shows Jira',
      description: 'Open the second window and look.',
      next_action: 'Claim it',
      company_slug: 'Unassigned',
      priority: 'normal'
    }
  }

  it("shows the card facts, what counts as done, and this person's handoffs on it", () => {
    const onSelectRow = vi.fn()
    render(
      <BackofficeWorkDetail
        row={cardRow}
        scope="scope"
        baseUrl="https://omnios.example.com"
        names={new Map([['emp_uma', 'Uma']])}
        itemActions={{
          onUseItem: vi.fn(),
          onArchiveItem: vi.fn(),
          archivePending: null
        }}
        onOpenTask={vi.fn()}
        onKeepRow={vi.fn()}
        markRead
        relatedRows={[threadRow(0)]}
        onSelectRow={onSelectRow}
      />
    )
    expect(screen.getByText('Uma')).toBeTruthy()
    expect(screen.getByText('sidebar shows Jira')).toBeTruthy()
    expect(screen.getByText('Open the second window and look.')).toBeTruthy()
    expect(screen.getByText('Open in the Console').closest('a')?.getAttribute('href')).toBe(
      'https://omnios.example.com/board/btk_one1'
    )
    fireEvent.click(screen.getByRole('button', { name: /Review/ }))
    expect(onSelectRow).toHaveBeenCalledWith('handoff:hth_one')
  })

  it('says the card is still being read, or why it could not be', () => {
    const props = {
      scope: 'scope',
      baseUrl: null,
      names: new Map<string, string>(),
      itemActions: {
        onUseItem: vi.fn(),
        onArchiveItem: vi.fn(),
        archivePending: null
      },
      onOpenTask: vi.fn(),
      onKeepRow: vi.fn(),
      markRead: true
    }
    render(<BackofficeWorkDetail {...props} row={{ ...cardRow, card: null }} />)
    expect(screen.getByText('Reading the card…')).toBeTruthy()
    cleanup()
    render(<BackofficeWorkDetail {...props} row={{ ...cardRow, card: null }} cardError="hub 403" />)
    expect(screen.getByText(/Could not read this card/)).toBeTruthy()
  })
})
