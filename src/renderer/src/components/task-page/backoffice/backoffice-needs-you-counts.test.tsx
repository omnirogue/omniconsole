// @vitest-environment happy-dom

import { cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AttentionPane } from '@/components/attention/agent-pane-snapshot'
import { AttentionWorkSummary } from '@/components/attention/AttentionWorkSummary'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { WorkNeedsYouBadge } from '@/components/sidebar/WorkNeedsYouBadge'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkNeedsYouSection } from '@/components/work/WorkNeedsYouSection'
import { makeWorktree } from '@/components/worktree-jump-palette-test-fixtures'
import { useAppStore } from '@/store'
import type { ConsoleWorkflowJob } from '../../../../../shared/console-workflow-types'
import type { PeerMessageThread } from '../../../../../shared/peer-message-contract'
import { BackofficeTodoListHost } from './backoffice-todo-list-host'
import { useBackofficeWorkStore } from './backoffice-work-store'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      params && name in params ? String(params[name]) : match
    ),
  i18n: { language: 'en' }
}))
const panes = vi.hoisted(() => ({ attention: [] as AttentionPane[] }))
vi.mock('@/components/attention/use-agent-pane-snapshot', () => ({
  useAgentPaneSnapshot: () => ({ attention: panes.attention })
}))
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => []
}))
const api = vi.hoisted(() => ({ list: vi.fn(), recipients: vi.fn(), get: vi.fn() }))
vi.mock('@/components/handoffs/handoff-client', () => ({
  handoffApi: () => api,
  capturePickedHandoffFile: vi.fn(),
  downloadHandoffVersion: vi.fn()
}))

function pane(paneKey: string, worktreeId = 'wt_1'): AttentionPane {
  return {
    paneKey,
    worktreeId,
    tabId: 'tab_1',
    leafId: null,
    agentType: 'claude',
    bucket: 'attention',
    dotState: 'attention',
    unseen: true,
    title: paneKey,
    stateChangedAt: 0,
    repoName: 'repo',
    worktreeName: 'main',
    cause: 'blocked',
    portalPaneKey: null
  } as unknown as AttentionPane
}

const thread = {
  id: 'hth_one',
  board_task_id: 'btk_9999',
  author_employee_id: 'emp_gamma',
  recipient_employee_id: 'emp_sal',
  title: 'Deck to review',
  state: 'open' as const,
  action: 'review' as const,
  due_at: null,
  parent_thread_id: null,
  delivery_id: null,
  updated: '2026-09-11T09:00:00Z',
  files: [],
  reviews: []
}

function job(): ConsoleWorkflowJob {
  return {
    id: 'job_decide01',
    task_id: 'btk_5555',
    node_id: null,
    title: 'Approve the pricing change',
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
    updated_at: '2026-09-11T12:00:00Z',
    policy: {
      workflow: {
        version: 1,
        digest: 'a'.repeat(64),
        mode: 'hybrid',
        dispatch_id: 'wf_1',
        workflow_id: 'wf_1',
        key: 'approve',
        actor_type: 'human',
        actor_id: 'emp_sal',
        action: 'approve',
        after: [],
        after_keys: [],
        require_merged: false,
        approval_ancestors: [],
        loop: null,
        owned_paths: [],
        skipped: false
      }
    } as unknown as ConsoleWorkflowJob['policy'],
    blockers: [],
    workflow_state: 'awaiting_human',
    can_decide: true
  } as ConsoleWorkflowJob
}

function message(): PeerMessageThread {
  return {
    id: 'msg_1',
    project_id: 'proj_1',
    task_id: null,
    sender_session_id: 'ses_a',
    recipient_session_id: 'ses_b',
    sender_employee_id: 'emp_gamma',
    recipient_employee_id: 'emp_sal',
    purpose: 'question',
    summary: 'Can you check the invoice?',
    state: 'delivered',
    created_at: 1_789_200_000,
    delivered_at: 1_789_200_100,
    replied_at: null,
    resolved_at: null,
    expires_at: null,
    reply: null
  }
}

function currentScope(): string {
  return renderHook(() => useHandoffScope()).result.current
}

/** The Tasks list, so its lens chip can be read beside the badge, the summary and the home. */
function taskList(): React.JSX.Element {
  return (
    <BackofficeTodoListHost
      state={{
        phase: 'ready',
        items: [],
        baseUrl: 'https://omnios.example.com',
        employeeId: 'emp_sal',
        generatedAt: null
      }}
      onRefresh={vi.fn()}
      onUseItem={vi.fn()}
      onArchiveItem={vi.fn()}
      archivePending={null}
      onOpenOffice={vi.fn()}
    />
  )
}

/** A workspace bound to a hub card, so a pane on it is the card's obligation, not a second one. */
function bindWorkspaceToCard(worktreeId: string, hubTaskId: string): void {
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(worktreeId, 'Bound workspace', {
          linkedWorkItem: {
            type: 'issue',
            provider: 'backoffice',
            number: 0,
            title: 'Ship completion',
            url: 'https://omnios.example.com',
            hubTaskId
          }
        })
      ]
    }
  })
}

/** One store fixture: a card, a received request, a sent request, a decision and a message. */
function seedStore(scope: string): void {
  const sent = {
    ...thread,
    id: 'hth_sent',
    author_employee_id: 'emp_sal',
    recipient_employee_id: 'emp_iris',
    title: 'Notes to Iris'
  }
  useBackofficeWorkStore.setState({
    scope,
    loadedAt: Date.now(),
    historyRequested: false,
    todo: {
      phase: 'ready',
      value: {
        ok: true,
        baseUrl: 'https://omnios.example.com',
        employeeId: 'emp_sal',
        generatedAt: null,
        items: [{ task_id: 'btk_1234', title: 'Ship completion', state_revision: 3 }],
        awaitingVerification: [],
        counts: null,
        truncated: false,
        nextCursor: null
      }
    },
    receivedOpen: {
      phase: 'ready',
      value: { assignee: 'emp_sal', threads: [thread], next_cursor: null }
    },
    receivedHistory: { phase: 'idle' },
    sent: {
      phase: 'ready',
      value: { assignee: 'emp_sal', view: 'sent', threads: [sent], next_cursor: null }
    },
    roster: { phase: 'ready', value: [] },
    humanActions: { phase: 'ready', value: [job()] },
    messages: { phase: 'ready', value: [message()] }
  })
}

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState({ worktreesByRepo: {} })
  panes.attention = [pane('tab_1:leaf_a'), pane('tab_1:leaf_b')]
  api.list.mockResolvedValue({ ok: true, data: { assignee: 'emp_sal', threads: [] } })
  api.recipients.mockResolvedValue({ ok: true, data: { employees: [] } })
  Object.assign(window, {
    api: {
      backoffice: { listTodo: vi.fn(), completeTask: vi.fn() },
      consoleWorkflows: { listHumanActions: vi.fn() }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  panes.attention = []
})

describe('one "need you" number', () => {
  it('shows the same total on the Work badge, the Work home and the Attention summary', async () => {
    seedStore(currentScope())
    render(
      <TooltipProvider>
        <WorkNeedsYouBadge />
        <AttentionWorkSummary />
        <WorkNeedsYouSection />
      </TooltipProvider>
    )
    // Why: two panes + the received handoff + the received message = 4. The plain card and
    // workflow decision stay in All.
    expect(await screen.findByRole('button', { name: '4 need you' })).toBeTruthy()
    expect(screen.getByLabelText('4 need you')).toBeTruthy()
    expect(screen.getByText('4 waiting on you')).toBeTruthy()
    // Why: a pane never waits on someone else; the sent request does.
    expect(screen.getByRole('button', { name: '1 waiting' })).toBeTruthy()
  })

  it('counts a pane bound to a needs-you card once, and the Tasks chip counts its own rows', async () => {
    const scope = currentScope()
    seedStore(scope)
    bindWorkspaceToCard('wt_bound', 'btk_9999')
    panes.attention = [pane('tab_1:leaf_a'), pane('tab_1:leaf_b', 'wt_bound')]
    const { container } = render(
      <TooltipProvider>
        <WorkNeedsYouBadge />
        <AttentionWorkSummary />
        <WorkNeedsYouSection />
        {taskList()}
      </TooltipProvider>
    )
    // Why: the bound pane and the handoff's card are one obligation; the free pane, handoff
    // and received message count once each.
    expect(await screen.findByRole('button', { name: '3 need you' })).toBeTruthy()
    expect(screen.getByLabelText('3 need you')).toBeTruthy()
    expect(screen.getByText('3 waiting on you')).toBeTruthy()
    expect(container.querySelectorAll('[data-work-needs-you-pane]')).toHaveLength(1)
    // Why: the Tasks list is console work by definition; its chip never counts panes.
    const chip = await waitFor(() => {
      const found = container.querySelector('[data-work-lens="needs-you"]')
      expect(found?.textContent).toBe('Needs You2')
      return found
    })
    expect(chip).toBeTruthy()
  })

  it('lists a run\'s request once as "Needs you: <ask>" with its why and the way to meet it', async () => {
    const scope = currentScope()
    seedStore(scope)
    bindWorkspaceToCard('wt_bound', 'btk_9999')
    const request = {
      ...pane('tab_1:leaf_b', 'wt_bound'),
      run: {
        chainId: 'chain',
        sourceRowKey: 'row',
        headline: 'Needs you: Sign claude in again.',
        why: "claude's provider rejected its sign-in, and only you hold those credentials.",
        requests: [
          {
            id: 'att_provider-authentication_outcome_1',
            kind: 'credential' as const,
            scope: { outcomeId: 'outcome', outcomeRevision: 1 },
            ask: 'Sign claude in again.',
            why: "claude's provider rejected its sign-in, and only you hold those credentials.",
            recipient: { type: 'owner' as const },
            action: { kind: 'sign-in' as const, label: 'Sign in' },
            source: { type: 'provider-authentication' as const, ref: 'claude' },
            state: 'open' as const,
            openedAt: 5
          }
        ]
      }
    }
    panes.attention = [pane('tab_1:leaf_a'), request]
    const { container } = render(
      <TooltipProvider>
        <WorkNeedsYouBadge />
        <WorkNeedsYouSection />
      </TooltipProvider>
    )
    // Why: a request names its own requirement, so the card its workspace is bound to does not
    // stand in for it: the free pane, the request, the handoff and the message are four.
    expect(await screen.findByLabelText('4 need you')).toBeTruthy()
    expect(screen.getByText('4 waiting on you')).toBeTruthy()
    const rows = container.querySelectorAll('[data-work-needs-you-request]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('Needs you: Sign claude in again.')
    expect(rows[0]!.textContent).toContain('only you hold those credentials')
    expect(rows[0]!.querySelector('[data-run-attention-action="sign-in"]')?.textContent).toBe(
      'Sign in'
    )
    expect(container.querySelectorAll('[data-work-needs-you-pane]')).toHaveLength(1)
  })

  it('shows the handoff and received message on the home, excluding derived decisions and plain cards', async () => {
    seedStore(currentScope())
    render(
      <TooltipProvider>
        <WorkNeedsYouSection />
      </TooltipProvider>
    )
    expect(await screen.findByText('Deck to review')).toBeTruthy()
    expect(screen.getByText('Can you check the invoice?')).toBeTruthy()
    // Why: this view includes received human messages but does not invent obligations from other work.
    expect(screen.queryByText('Approve the pricing change')).toBeNull()
    expect(screen.queryByText('Ship completion')).toBeNull()
  })

  it('does not claim the feed is unavailable while the first load is still running', () => {
    const scope = currentScope()
    panes.attention = []
    useBackofficeWorkStore.setState({
      scope,
      loadedAt: null,
      historyRequested: false,
      todo: { phase: 'loading', previous: null },
      receivedOpen: { phase: 'loading', previous: null },
      receivedHistory: { phase: 'idle' },
      sent: { phase: 'loading', previous: null },
      roster: { phase: 'loading', previous: null },
      humanActions: { phase: 'loading', previous: null },
      messages: { phase: 'loading', previous: null }
    })
    render(
      <TooltipProvider>
        <WorkNeedsYouSection />
      </TooltipProvider>
    )
    expect(
      within(screen.getByRole('region', { name: 'Needs you' })).queryByRole('status')
    ).toBeNull()
    expect(
      within(screen.getByRole('region', { name: 'Needs you' })).getByText('Loading…')
    ).toBeTruthy()
    // Why: a read that has not answered yet is not a gap; the strip waits for the first answer.
    expect(screen.queryByText(/^Partial:/)).toBeNull()
  })

  it('names the incomplete feed once the reads have answered', async () => {
    const scope = currentScope()
    seedStore(scope)
    useBackofficeWorkStore.setState({ sent: { phase: 'not-served' } })
    render(
      <TooltipProvider>
        <WorkNeedsYouSection />
      </TooltipProvider>
    )
    expect(await screen.findByText(/^Partial:/)).toBeTruthy()
  })

  it('names the feed as unavailable once both reads have failed', async () => {
    const scope = currentScope()
    useBackofficeWorkStore.setState({
      scope,
      loadedAt: Date.now(),
      historyRequested: false,
      todo: { phase: 'error', message: 'down', previous: null },
      receivedOpen: { phase: 'error', message: 'down', previous: null },
      receivedHistory: { phase: 'idle' },
      sent: { phase: 'error', message: 'down', previous: null },
      roster: { phase: 'error', message: 'down', previous: null },
      humanActions: { phase: 'error', message: 'down', previous: null },
      messages: { phase: 'error', message: 'down', previous: null }
    })
    render(
      <TooltipProvider>
        <WorkNeedsYouSection />
      </TooltipProvider>
    )
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Needs you' })).getByRole('status')
      ).toBeTruthy()
    )
  })
})
