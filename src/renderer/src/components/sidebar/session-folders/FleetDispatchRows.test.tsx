// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import type * as HttpLinkRouting from '@/lib/http-link-routing'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { ConversationFleetView } from '@/store/conversation-fleet-store'
import { useAppStore } from '@/store'
import { useSessionSelection } from '@/store/session-selection'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import type { ConsoleWorkflowJob } from '../../../../../shared/console-workflow-types'
import { FleetDispatchRows } from './FleetDispatchRows'
import { FleetDispatchSummaryProvider } from './FleetDispatchSummaryProvider'
import { useSessionRowHosts } from './use-session-row-host-label'

// These cover the hand composer itself, which ships behind a flag that is off.
vi.mock('@/components/next-action/up-next-composer-flag', () => ({
  UP_NEXT_COMPOSER_ENABLED: true
}))

// Exercise the control contract with a supporting server; production remains gated.
vi.mock('../../../../../shared/fleet-execution-controls', () => ({
  fleetExecutionControlsAvailable: true
}))

const mocks = vi.hoisted(() => ({
  pause: vi.fn(),
  open: vi.fn(),
  openLink: vi.fn(),
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), message: vi.fn(), warning: vi.fn() },
  api: { cancelWorkflow: vi.fn(), retryJob: vi.fn(), getWorkflow: vi.fn() }
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/lib/http-link-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpLinkRouting>()),
  openHttpLink: mocks.openLink
}))
vi.mock('@/lib/conversation-fleet-pause', () => ({ pauseSidebarSession: mocks.pause }))
vi.mock('@/components/console-workflows/WorkflowDetail', () => ({
  WorkflowDetail: () => <div data-testid="workflow-detail" />
}))

const source: SidebarSession = {
  rowKey: 'source-row',
  sessionKey: 'source-session',
  worktreeId: 'repo:/workspace',
  hostId: 'local',
  tabId: 'term:tab-1',
  paneKey: 'term:tab-1:pane-1',
  kind: 'terminal',
  label: 'Build landing page',
  workspaceLabel: 'Website',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}
const run: ConversationFleetView = {
  workflowId: 'wf_12345678',
  taskId: 'btk_12345678',
  rowKey: source.rowKey,
  sessionKey: source.sessionKey,
  title: 'Fleet test: landing page',
  createdAt: '2026-09-12T14:00:00.000Z',
  machine: 'mw0002',
  jobs: [{ id: 'job_1', status: 'running', machine: 'mw0002' } as ConsoleWorkflowJob],
  admission: 'accepted',
  verified: true,
  error: null
}
const title = run.title

function renderRows(
  rows: { run: ConversationFleetView; source: SidebarSession | null }[],
  selection?: Parameters<typeof FleetDispatchRows>[0]['selection']
) {
  return render(
    <TooltipProvider>
      <FleetDispatchSummaryProvider runs={rows.map(({ run }) => run)}>
        <FleetDispatchRows rows={rows} selection={selection} onOpenSource={mocks.open} />
      </FleetDispatchSummaryProvider>
    </TooltipProvider>
  )
}

async function openMore(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'More options' }))
  return screen.getByRole('menu')
}

function stage(id: string, status: string, after: string[] = []): ConsoleWorkflowJob {
  return {
    id,
    status,
    machine: 'mw0002',
    can_decide: false,
    policy: { workflow: { after } }
  } as unknown as ConsoleWorkflowJob
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { api: unknown }).api = { consoleWorkflows: mocks.api }
  mocks.api.getWorkflow.mockResolvedValue({
    ok: true,
    data: { workflow_id: run.workflowId, jobs: [] }
  })
  useSessionSidebarView.setState({
    view: emptySessionSidebarView(),
    archived: [],
    loaded: true,
    showHidden: false
  })
  useSessionSelection.getState().set([])
})
afterEach(cleanup)

describe('FleetDispatchRows selection', () => {
  it('opens the actual review link in the summary instead of routing reviews to Decisions', async () => {
    const user = userEvent.setup()
    const review = {
      ...run,
      jobs: [
        { ...stage('job_review', 'pr_open'), pr_url: 'https://github.com/example/repo/pull/1' }
      ]
    }
    renderRows([{ run: review, source: null }])
    expect(screen.getByRole('img', { name: 'Review ready' })).toBeTruthy()
    const action = screen.getByRole('button', { name: `View review for ${title}` })
    expect(action.textContent).toBe('')
    await user.click(action)
    const summary = await screen.findByRole('dialog')
    expect(within(summary).getByRole('link', { name: 'Open review' }).getAttribute('href')).toBe(
      'https://github.com/example/repo/pull/1'
    )
    expect(mocks.openLink).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /^(Review|Answer)$/ })).toBeNull()
  })
  it('selects by checkbox under the key its sidebar row is filed under, like a conversation row', async () => {
    const user = userEvent.setup()
    renderRows([{ run, source }])
    const checkbox = screen.getByRole('checkbox', { name: `Select ${title}` })
    await user.click(checkbox)
    expect(useSessionSelection.getState().keys).toEqual(['source-session'])
    expect(
      document.querySelector('[data-session-key="source-session"][data-selected]')
    ).toBeTruthy()
    await user.click(checkbox)
    expect(useSessionSelection.getState().keys).toEqual([])

    cleanup()
    renderRows([{ run: { ...run, sessionKey: null }, source: null }])
    await user.click(screen.getByRole('checkbox', { name: `Select ${title}` }))
    expect(useSessionSelection.getState().keys).toEqual(['source-row'])
  })

  it('treats a modified click as a selection gesture and a plain click as open', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn((_key: string, event: { shiftKey: boolean }) => event.shiftKey)
    renderRows([{ run, source }], { selectedKeys: new Set(), focusKey: null, onSelect })
    const open = screen.getByRole('button', { name: `Open session ${title}` })
    expect(open.getAttribute('data-session-open')).toBe('')
    expect(open.tabIndex).toBe(-1)
    await user.keyboard('{Shift>}')
    await user.click(open)
    await user.keyboard('{/Shift}')
    expect(onSelect).toHaveBeenLastCalledWith(
      'source-session',
      expect.objectContaining({ shiftKey: true })
    )
    expect(mocks.open).not.toHaveBeenCalled()
    await user.click(open)
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(source)

    cleanup()
    renderRows([{ run, source }], {
      selectedKeys: new Set(['source-session']),
      focusKey: 'source-session',
      onSelect
    })
    expect(screen.getByRole('option', { name: /Fleet test/ }).getAttribute('aria-selected')).toBe(
      'true'
    )
    expect(screen.getByRole('button', { name: `Open session ${title}` }).tabIndex).toBe(0)
  })
})

describe('FleetDispatchRows lifecycle controls', () => {
  it('matches compact session rows and opens the source from its title', async () => {
    const user = userEvent.setup()
    renderRows([{ run, source }])
    const row = document.querySelector('[data-fleet-row="source-row"]')!
    expect(row.getAttribute('data-session-density')).toBe('compact')
    expect(row.querySelector('[data-conversation-state-size="sm"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: `Open session ${title}` }).classList).toContain(
      'py-1'
    )
    expect(screen.queryByText(/mw0002/)).toBeNull()
    await user.click(screen.getByRole('button', { name: `Open session ${title}` }))
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(source)
    expect(screen.getByRole('button', { name: 'Up next' })).toBeTruthy()

    cleanup()
    renderRows([{ run, source: null }])
    expect(screen.queryByRole('button', { name: /Open session/ })).toBeNull()
    expect(screen.getByText(title)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Up next' })).toBeNull()
    expect(screen.getByRole('button', { name: `Hide ${title}` })).toBeTruthy()
    expect(screen.getByRole('button', { name: `Archive ${title}` })).toBeTruthy()
  })

  it('respects comfortable density when the person asks for more detail', () => {
    useSessionSidebarView.setState({
      view: { ...emptySessionSidebarView(), density: 'comfortable' }
    })
    renderRows([{ run, source }])
    expect(document.querySelector('[data-session-density="comfortable"]')).toBeTruthy()
    expect(document.querySelector('[data-conversation-state-size="md"]')).toBeTruthy()
    expect(screen.getByText('Working · mw0002')).toBeTruthy()
    expect(screen.getByRole('button', { name: `Open session ${title}` }).classList).toContain(
      'py-2'
    )
  })

  it('opens a quiet source-less row directly to its summary', async () => {
    const user = userEvent.setup()
    renderRows([{ run: { ...run, jobs: [stage('job_rejected', 'rejected')] }, source: null }])
    await user.click(screen.getByRole('button', { name: `View summary for ${title}` }))
    const summary = await screen.findByRole('dialog')
    expect(
      within(summary).getByText('Some work couldn’t finish. Steps finished: 0 of 1.')
    ).toBeTruthy()
    expect(within(summary).queryByTestId('workflow-detail')).toBeNull()
    expect(mocks.openLink).not.toHaveBeenCalled()
    expect(mocks.api.retryJob).not.toHaveBeenCalled()
  })

  it('dates comfortable rows by recorded job activity, never receipt recovery', () => {
    useSessionSidebarView.setState({
      view: { ...emptySessionSidebarView(), density: 'comfortable' }
    })
    const failed = {
      ...run,
      createdAt: '2020-01-01T00:00:00.000Z',
      jobs: [stage('job_failed', 'failed')]
    }
    renderRows([{ run: failed, source: null }])
    expect(
      screen.getByRole('button', { name: `View summary for ${title}` }).textContent
    ).not.toContain('2020')
    cleanup()
    renderRows([
      {
        run: { ...failed, jobs: [{ ...failed.jobs[0], updated_at: '2020-01-02T12:00:00.000Z' }] },
        source: null
      }
    ])
    expect(screen.getByRole('button', { name: `View summary for ${title}` }).textContent).toContain(
      '2020'
    )
  })

  it('keeps opening a reachable source when its work needs a decision', async () => {
    const user = userEvent.setup()
    renderRows([
      { run: { ...run, jobs: [{ ...stage('job_decide', 'blocked'), can_decide: true }] }, source }
    ])
    await user.click(screen.getByRole('button', { name: `Open session ${title}` }))
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(source)
    expect(mocks.openLink).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: `Open decisions for ${title}` }))
    expect(mocks.openLink).toHaveBeenCalledExactlyOnceWith(
      'https://console.example.com/work/decisions',
      { forceSystemBrowser: true }
    )
  })

  it('keeps a failure quiet when it has no supported retry', () => {
    renderRows([{ run: { ...run, jobs: [stage('job_rejected', 'rejected')] }, source: null }])
    expect(screen.queryByRole('button', { name: /Try .* again|Open decisions/ })).toBeNull()
    expect(screen.queryByText(/Couldn.t finish|Fleet work failed/)).toBeNull()
    expect(document.querySelector('[data-conversation-state="failed"] svg')?.classList).toContain(
      'text-muted-foreground'
    )
    expect(
      document.querySelector('[data-conversation-state="failed"] svg')?.classList
    ).not.toContain('text-destructive')
  })

  it('hides and archives by the key the sidebar groups read, with or without a source', async () => {
    const user = userEvent.setup()
    renderRows([{ run, source }])
    await user.click(screen.getByRole('button', { name: `Hide ${title}` }))
    expect(useSessionSidebarView.getState().view.hidden).toEqual(['conversation:source-session'])
    await user.click(screen.getByRole('button', { name: `Show ${title}` }))
    expect(useSessionSidebarView.getState().view.hidden).toEqual([])
    await user.click(screen.getByRole('button', { name: `Archive ${title}` }))
    expect(useSessionSidebarView.getState().archived).toEqual(['source-session'])
    await user.click(screen.getByRole('button', { name: `Unarchive ${title}` }))
    expect(useSessionSidebarView.getState().archived).toEqual([])

    cleanup()
    renderRows([{ run: { ...run, sessionKey: null }, source: null }])
    await user.click(screen.getByRole('button', { name: `Archive ${title}` }))
    expect(useSessionSidebarView.getState().archived).toEqual(['source-row'])
  })

  it.each([
    ['paused', 'success'],
    ['already-idle', 'info'],
    ['source-changed', 'error'],
    ['unverifiable', 'error']
  ] as const)('pauses the source chat and reports %s as a %s toast', async (state, level) => {
    const user = userEvent.setup()
    mocks.pause.mockResolvedValueOnce({ state, message: `Result: ${state}` })
    renderRows([{ run, source }])
    const menu = await openMore(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Pause source chat' }))
    await waitFor(() => expect(mocks.toast[level]).toHaveBeenCalledWith(`Result: ${state}`))
    expect(mocks.pause).toHaveBeenCalledExactlyOnceWith(source)
    const others = (['success', 'info', 'error'] as const).filter((other) => other !== level)
    for (const other of others) {
      expect(mocks.toast[other]).not.toHaveBeenCalled()
    }
  })

  it('offers no pause without a reachable source, and Cancel only for confirmed live fleet work', async () => {
    const user = userEvent.setup()
    renderRows([{ run, source: { ...source, unavailable: true } }])
    expect(screen.queryByRole('button', { name: `Open session ${title}` })).toBeNull()
    let menu = await openMore(user)
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['View summary', 'Cancel fleet work…'])
    await user.keyboard('{Escape}')

    cleanup()
    renderRows([{ run, source: null }])
    menu = await openMore(user)
    expect(within(menu).queryByRole('menuitem', { name: 'Pause source chat' })).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: 'Cancel fleet work…' })).toBeTruthy()
    await user.keyboard('{Escape}')

    for (const settled of [
      { ...run, admission: 'pending' as const },
      { ...run, verified: false },
      { ...run, jobs: [stage('job_1', 'done')] },
      { ...run, verified: false, jobs: [stage('job_1', 'failed')] },
      { ...run, admission: 'pending' as const, jobs: [stage('job_1', 'failed')] }
    ]) {
      cleanup()
      renderRows([{ run: settled, source: null }])
      expect(screen.queryByRole('button', { name: `Try ${title} again` })).toBeNull()
      menu = await openMore(user)
      expect(within(menu).queryByRole('menuitem', { name: /cancel|retry/i })).toBeNull()
      await user.keyboard('{Escape}')
    }
  })

  it('cancels the fleet workflow only after confirmation and says when running stages stop', async () => {
    const user = userEvent.setup()
    mocks.api.cancelWorkflow.mockResolvedValueOnce({
      ok: false,
      error: { code: 'owner_required', message: 'Only the owner cancels it' }
    })
    renderRows([{ run, source }])
    await user.click(
      within(await openMore(user)).getByRole('menuitem', { name: 'Cancel fleet work…' })
    )
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/has 1 unfinished stages/)).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Keep running' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mocks.api.cancelWorkflow).not.toHaveBeenCalled()

    await user.click(
      within(await openMore(user)).getByRole('menuitem', { name: 'Cancel fleet work…' })
    )
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel fleet work' }))
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Only the owner cancels it'))
    expect(screen.getByRole('dialog')).toBeTruthy()

    mocks.api.cancelWorkflow.mockResolvedValueOnce({
      ok: true,
      data: {
        workflow_id: run.workflowId,
        jobs: [stage('job_1', 'cancelled')],
        cancelled: ['job_1'],
        cancel_requested: ['job_1'],
        already_cancelled: [],
        finished: [],
        refused: []
      }
    })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel fleet work' }))
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith(
        'Fleet work cancelled. 1 running stages stop when their fleet machine next checks in.'
      )
    )
    expect(mocks.api.cancelWorkflow).toHaveBeenLastCalledWith({ workflowId: run.workflowId })
    expect(mocks.api.cancelWorkflow).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('retries stopped stages after the stages they wait on, holding dependents of a refusal', async () => {
    const user = userEvent.setup()
    const stopped = {
      ...run,
      jobs: [
        stage('job_later', 'cancelled', ['job_first']),
        stage('job_first', 'failed'),
        stage('job_done', 'done')
      ]
    }
    mocks.api.retryJob.mockImplementation(async ({ jobId }: { jobId: string }) => ({
      ok: true,
      data: { job: { id: jobId, status: 'queued' } }
    }))
    renderRows([{ run: stopped, source: null }])
    let menu = await openMore(user)
    expect(within(menu).queryByRole('menuitem', { name: 'Cancel fleet work…' })).toBeNull()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: `Try ${title} again` }))
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith('2 stopped stages queued again.')
    )
    expect(mocks.api.retryJob.mock.calls.map(([args]) => args.jobId)).toEqual([
      'job_first',
      'job_later'
    ])

    mocks.api.retryJob.mockReset()
    mocks.api.retryJob.mockResolvedValue({
      ok: false,
      error: { code: 'execution_unresolved', message: 'Still stopping' }
    })
    menu = await openMore(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Try again' }))
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith('1 stages were not retried: Still stopping')
    )
    expect(mocks.api.retryJob).toHaveBeenCalledExactlyOnceWith({ jobId: 'job_first' })
  })

  it('opens a summary from source-less rows before offering decisions or reviews', async () => {
    const user = userEvent.setup()
    const decision = {
      ...run,
      jobs: [
        {
          id: 'job_decide',
          title: 'Analyze',
          status: 'blocked',
          can_decide: true,
          workflow_state: 'needs_human',
          blockers: [],
          policy: { workflow: { actor_id: 'sal', action: 'approve', after: [] } }
        } as unknown as ConsoleWorkflowJob
      ]
    }
    renderRows([{ run: decision, source: null }])
    await user.click(screen.getByRole('button', { name: `View summary for ${title}` }))
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.openLink).not.toHaveBeenCalled()
    const summary = await screen.findByRole('dialog')
    await user.click(within(summary).getByRole('button', { name: 'Open Decisions' }))
    expect(mocks.openLink).toHaveBeenCalledExactlyOnceWith(
      'https://console.example.com/work/decisions',
      {
        forceSystemBrowser: true
      }
    )

    cleanup()
    const review = {
      ...run,
      jobs: [
        {
          id: 'job_pr',
          status: 'pr_open',
          pr_url: 'https://example.test/pr/7'
        } as ConsoleWorkflowJob
      ]
    }
    renderRows([{ run: review, source: { ...source, unavailable: true } }])
    await user.click(screen.getByRole('button', { name: `View summary for ${title}` }))
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.openLink).toHaveBeenCalledTimes(1)
    expect(
      within(await screen.findByRole('dialog'))
        .getByRole('link', { name: 'Open review' })
        .getAttribute('href')
    ).toBe('https://example.test/pr/7')
  })

  it('keeps summary reachable from More options and technical details closed', async () => {
    const user = userEvent.setup()
    renderRows([{ run, source }])
    const menu = await openMore(user)
    const details = within(menu).getByRole('menuitem', { name: 'View summary' })
    expect(details.getAttribute('data-fleet-workflow')).toBe(run.workflowId)
    await user.click(details)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: title })).toBeTruthy()
    expect(within(dialog).getByText('Working')).toBeTruthy()
    expect(within(dialog).queryByTestId('workflow-detail')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Try again' })).toBeNull()
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More options' }))
    )
  })
})

describe('FleetDispatchRows computer name', () => {
  const STUDIO_ID = '7f3c2a9e-1b4d-4c6e-9a8f-2d5b6c7e8f90'
  const environmentsBefore = useAppStore.getState().runtimeEnvironments

  afterEach(() => {
    useAppStore.setState({ runtimeEnvironments: environmentsBefore })
    useSessionRowHosts.setState({ shown: false })
  })

  it("names the dispatching conversation's computer when the list mixes computers", () => {
    useAppStore.setState({ runtimeEnvironments: [{ id: STUDIO_ID, name: 'Mac Studio' }] as never })
    useSessionRowHosts.setState({ shown: true })
    renderRows([{ run, source: { ...source, hostId: `runtime:${STUDIO_ID}` } }])
    const label = document.querySelector('[data-fleet-row] [data-session-host-label]')!
    expect(label.textContent).toBe('Mac Studio')
    expect(screen.getByRole('button', { name: `Open session ${title} on Mac Studio` })).toBeTruthy()
    expect(screen.queryByText(/mw0002/)).toBeNull()

    cleanup()
    useSessionRowHosts.setState({ shown: false })
    renderRows([{ run, source }])
    expect(document.querySelector('[data-session-host-label]')).toBeNull()
  })
})
