// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { conversationPlanFixture } from '@/lib/conversation-plan-fixture'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import { sessionRunRowState } from '@/lib/session-run-row-state'
import {
  clearSessionChainEntries,
  getSessionChain,
  publishSessionChains,
  setSessionChainEntry
} from '@/lib/session-chain-registry'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import type { SessionChain } from '../../../../../shared/session-chain-types'
import { SessionSidebarRow } from './SessionSidebarRow'

/**
 * Why these tests exist: every row used to print its whole stack — the full blocked sentence,
 * the plan notation, "Seats and plan history", the queue count — and rows with a queue or a
 * plan lost their Hide and Archive buttons. A row now says one line and folds the rest.
 */
vi.mock('@/components/next-step/add-next/AddNextPanels', () => ({
  AddNextPanels: () => <div role="menu">Legacy recipient menu</div>
}))
vi.mock('@/lib/session-outcome-connection', () => ({
  sessionOutcomeConnection: () => ({
    negotiate: async () => ({ call: async () => ({ files: [] }) })
  })
}))
const retrySessionDisposition = vi.hoisted(() => vi.fn())
vi.mock('@/components/next-step/next-step-outcome-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  retrySessionDisposition
}))

const LONG_REASON =
  "No activity was observed for 180s after this step's instruction was accepted, so the step is not running. Open that conversation to see what happened, then run the step again."

const session: SidebarSession = {
  rowKey: 'row-1',
  sessionKey: 'session-1',
  worktreeId: 'folder:1',
  hostId: 'local',
  tabId: 'term:tab-1',
  paneKey: 'term:tab-1:pane-1',
  kind: 'terminal',
  label: 'Make a clock',
  workspaceLabel: 'Website',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}

const NOW = 1_000_000_000

function blockedPlan(): SessionChain {
  const chain = conversationPlanFixture()
  // Why: a stopped plan has no attempt running; the outcome carries the diagnostic it stopped with.
  chain.outcomeSet!.attempts = []
  chain.outcomeSet!.outcomes[0]!.status = 'blocked'
  chain.outcomeSet!.outcomes[0]!.blockedReason = LONG_REASON
  return chain
}

function renderRow(overrides: Partial<ComponentProps<typeof SessionSidebarRow>> = {}) {
  const props: ComponentProps<typeof SessionSidebarRow> = {
    session,
    current: false,
    queued: false,
    onOpen: vi.fn(),
    onCancelQueue: vi.fn(),
    ...overrides
  }
  const view = render(
    <TooltipProvider>
      <SessionSidebarRow {...props} />
    </TooltipProvider>
  )
  return { props, view }
}

const details = () => screen.getByRole('button', { name: 'Show details for Make a clock' })

beforeEach(() => {
  useSessionSidebarView.setState({
    // Why comfortable: these tests read the agent and status lines on the row itself; the
    // default compact row keeps them for its hover card (see SessionSidebarRow.compact.test).
    view: { ...emptySessionSidebarView(), density: 'comfortable' },
    archived: [],
    loaded: true,
    showHidden: false
  })
  useSessionFolders.setState({
    metadata: emptySessionFolderMetadata(),
    loaded: true,
    error: null
  })
})

afterEach(() => {
  cleanup()
  clearSessionChainEntries()
  publishSessionChains()
  retrySessionDisposition.mockReset()
})

describe('one status line, details on demand', () => {
  it('shows one truncated Failed line and no plan lines until the row is expanded', async () => {
    const user = userEvent.setup()
    renderRow({
      queued: true,
      pursuitChain: blockedPlan(),
      pursuitState: 'failed',
      run: sessionRunRowState(blockedPlan(), { now: NOW }),
      chain: {
        chainId: 'chain',
        rowKey: 'row-1',
        queued: 2,
        total: 3,
        state: 'waiting',
        auto: true,
        destination: { kind: 'done' },
        blocked: null,
        launchedPaneKeys: [],
        error: null
      }
    })
    const line = document.querySelector('[data-session-status]')!
    expect(line.getAttribute('data-session-status')).toBe('failed')
    // Why: the watchdog's sentence is a diagnostic. The row says the failure in plain words and
    // the sentence reads only in the details block below.
    expect(line.textContent).toBe('Failed · Automatic recovery could not continue')
    expect(line.textContent).not.toContain('No activity was observed')
    expect(line.querySelector('.truncate')).toBeTruthy()
    expect(line.className).not.toContain('whitespace-normal')
    // Why: a failure is not a question. It never wears the asking colour, never lights the row
    // up, and its full diagnostic is not even a hover away: it lives in the details.
    expect(line.className).toContain('text-destructive')
    expect(line.className).not.toContain('text-agent-question-text')
    expect(line.getAttribute('title')).toBeNull()
    expect(document.querySelector('[data-needs-attention]')).toBeNull()
    expect(screen.queryByText(/Open that conversation to see what happened/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Seats and plan history' })).toBeNull()
    expect(screen.queryByText('2 sessions queued')).toBeNull()
    expect(document.querySelector('[data-work-plan-row]')).toBeNull()

    await user.click(details())

    const block = document.querySelector('[data-session-row-details]')!
    expect(within(block as HTMLElement).getByText(`Plan the work: ${LONG_REASON}`)).toBeTruthy()
    expect(within(block as HTMLElement).getByText(/done-when · stage/)).toBeTruthy()
    expect(
      within(block as HTMLElement).getByRole('button', {
        name: 'Seats and plan history'
      })
    ).toBeTruthy()
    // Why: a failed run is over; nothing is queued after it any more, in the row or under it.
    expect(within(block as HTMLElement).queryByText('2 sessions queued')).toBeNull()
    expect(screen.getByRole('button', { name: 'Hide details for Make a clock' })).toBeTruthy()
  })

  it('says "Needs you: <ask>" in the asking style, with the why in the details', async () => {
    const user = userEvent.setup()
    const chain = blockedPlan()
    chain.outcomeSet!.attention = [
      {
        id: 'att_review-findings_outcome_1',
        kind: 'decision',
        scope: { outcomeId: 'outcome', outcomeRevision: 1 },
        ask: 'Decide what happens to 2 open review findings.',
        why: 'All 2 authorized review rounds are used; another one needs your say.',
        recipient: { type: 'owner' },
        action: { kind: 'open-up-next', label: 'Decide' },
        source: { type: 'review-findings', ref: 'rounds:2' },
        state: 'open',
        openedAt: 5
      }
    ]
    const run = sessionRunRowState(chain, { now: NOW })
    renderRow({
      pursuitChain: chain,
      pursuitState: 'needs-you',
      run,
      planNeedsYou: run.countsAsAttention
    })
    const line = document.querySelector('[data-session-status]')!
    expect(line.getAttribute('data-session-status')).toBe('ask')
    expect(line.textContent).toBe('Needs you: Decide what happens to 2 open review findings.')
    expect(line.className).toContain('text-agent-question-text')
    expect(document.querySelector('[data-needs-attention]')).toBeTruthy()
    // Why: the blocked reason is a diagnostic; it is never what the row asks.
    expect(screen.queryByText(/No activity was observed/)).toBeNull()
    await user.click(details())
    const block = document.querySelector('[data-session-row-details]')!
    expect(
      within(block as HTMLElement).getByText(
        'All 2 authorized review rounds are used; another one needs your say.'
      )
    ).toBeTruthy()
    // The ask reads in full beside the direct way to meet it: this conversation's Up next.
    const request = block.querySelector('[data-session-request]') as HTMLElement
    expect(request.textContent).toContain('Decide what happens to 2 open review findings.')
    const action = request.querySelector('[data-session-request-action="open-up-next"]')!
    expect(within(action as HTMLElement).getByRole('button').textContent).toBe('Decide')
  })

  it('offers no request action on a run that asks nothing', async () => {
    const user = userEvent.setup()
    renderRow({
      pursuitChain: blockedPlan(),
      pursuitState: 'failed',
      run: sessionRunRowState(blockedPlan(), { now: NOW })
    })
    await user.click(details())
    expect(document.querySelector('[data-session-requests]')).toBeNull()
    expect(document.querySelector('[data-session-request-action]')).toBeNull()
  })

  it('stays quiet while the host recovers or waits by itself', () => {
    const chain = blockedPlan()
    chain.outcomeSet!.outcomes[0]!.block = {
      class: 'recovering',
      code: 'dispatch-stall',
      since: NOW - 1_000,
      until: NOW + 30_000
    }
    renderRow({
      pursuitChain: chain,
      pursuitState: 'recovering',
      run: sessionRunRowState(chain, { now: NOW })
    })
    const line = document.querySelector('[data-session-status]')!
    expect(line.getAttribute('data-session-status')).toBe('recovering')
    expect(line.textContent).toBe('Recovering · retrying automatically')
    expect(line.className).toContain('text-muted-foreground')
    expect(document.querySelector('[data-needs-attention]')).toBeNull()
  })

  it('shows only the archived caption on an archived run that is over', () => {
    const chain = blockedPlan()
    renderRow({
      queued: true,
      archived: true,
      pursuitChain: chain,
      pursuitState: 'failed',
      run: sessionRunRowState(chain, { now: NOW, archived: true }),
      chain: {
        chainId: 'chain',
        rowKey: 'row-1',
        queued: 2,
        total: 3,
        state: 'waiting',
        auto: true,
        destination: { kind: 'done' },
        blocked: null,
        launchedPaneKeys: [],
        error: null
      }
    })
    const lines = document.querySelectorAll('[data-session-status]')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.getAttribute('data-session-status')).toBe('caption')
    expect(lines[0]!.textContent).toBe('Archived')
    expect(screen.queryByText(/sessions queued/)).toBeNull()
    expect(screen.queryByText(/^Failed/)).toBeNull()
    expect(document.querySelector('[data-needs-attention]')).toBeNull()
  })

  it('shows only the finished caption on a sealed run, whatever arrived after the seal', () => {
    const chain = blockedPlan()
    chain.outcomeSet!.completion = {
      at: NOW - 5_000,
      outcomes: [{ id: 'outcome', revision: 1 }],
      evidenceIds: []
    }
    chain.outcomeSet!.continuation.state = 'unverifiable'
    renderRow({
      queued: true,
      pursuitChain: chain,
      pursuitState: 'done',
      run: sessionRunRowState(chain, { now: NOW }),
      completed: { reason: 'done', at: NOW - 5_000 }
    })
    const lines = document.querySelectorAll('[data-session-status]')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.textContent).toBe('Plan finished · complete')
    expect(screen.queryByText('Next session queued')).toBeNull()
    expect(document.querySelector('[data-needs-attention]')).toBeNull()
  })

  it('keeps a run whose close ran out of retries Completed, with a quiet Try again in the details', async () => {
    const user = userEvent.setup()
    const chain = blockedPlan()
    chain.state = 'done'
    chain.outcomeSet!.completion = {
      at: NOW - 5_000,
      outcomes: [{ id: 'outcome', revision: 1 }],
      evidenceIds: []
    }
    chain.outcomeSet!.disposition = {
      intent: 'close',
      state: 'failed',
      operationId: 'op_1',
      attempts: 5,
      lastError: 'The session is pinned or declined to close.',
      updatedAt: NOW - 1_000
    }
    const retried: SessionChain = {
      ...chain,
      outcomeSet: {
        ...chain.outcomeSet!,
        disposition: { ...chain.outcomeSet!.disposition!, state: 'pending', attempts: 0 }
      }
    }
    retrySessionDisposition.mockResolvedValue(retried)
    renderRow({
      pursuitChain: chain,
      pursuitState: 'done',
      run: sessionRunRowState(chain, { now: NOW }),
      completed: { reason: 'done', at: NOW - 5_000 }
    })
    // The row reads Completed and nothing else: not a request, not a failure, not lit up.
    const lines = document.querySelectorAll('[data-session-status]')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.getAttribute('data-session-status')).toBe('caption')
    expect(lines[0]!.textContent).toBe('Plan finished · complete')
    expect(document.querySelector('[data-needs-attention]')).toBeNull()
    expect(screen.queryByText(/Could not close/)).toBeNull()

    await user.click(details())
    const block = document.querySelector('[data-session-row-details]') as HTMLElement
    const quiet = block.querySelector('[data-session-disposition-failed="close"]') as HTMLElement
    expect(quiet.textContent).toContain('Could not close this session')
    expect(quiet.className).toContain('text-muted-foreground')
    expect(block.textContent).not.toMatch(/needs you/i)
    expect(block.querySelector('[data-session-requests]')).toBeNull()
    // The host's reason is a diagnostic: it reads only once Details is opened.
    expect(block.textContent).not.toContain('pinned or declined')
    await user.click(within(quiet).getByRole('button', { name: /Details/ }))
    expect(quiet.querySelector('[data-up-next-diagnostic-text]')!.textContent).toBe(
      'The session is pinned or declined to close.'
    )
    await user.click(within(quiet).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(retrySessionDisposition).toHaveBeenCalledExactlyOnceWith(chain))
    // The host's answer goes into the registry, whose subscribers carry the close out.
    await waitFor(() =>
      expect(getSessionChain(chain.id)?.outcomeSet?.disposition?.state).toBe('pending')
    )
  })

  it('keeps the expanded state in the view store across a re-render', async () => {
    const user = userEvent.setup()
    const { props, view } = renderRow({
      pursuitChain: blockedPlan(),
      pursuitState: 'failed',
      run: sessionRunRowState(blockedPlan(), { now: NOW })
    })
    await user.click(details())
    expect(useSessionSidebarView.getState().view.expandedRows).toEqual(['session-1'])
    view.rerender(
      <TooltipProvider>
        <SessionSidebarRow {...props} current />
      </TooltipProvider>
    )
    expect(document.querySelector('[data-session-row-details]')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Hide details for Make a clock' }))
    expect(document.querySelector('[data-session-row-details]')).toBeNull()
    expect(useSessionSidebarView.getState().view.expandedRows).toEqual([])
  })

  it('offers no chevron on a row with nothing to fold', () => {
    renderRow()
    expect(screen.queryByRole('button', { name: /details for Make a clock/ })).toBeNull()
    expect(document.querySelector('[data-session-status]')).toBeNull()
  })

  it('keeps the ask ahead of the queue count, which waits in the details', async () => {
    const user = userEvent.setup()
    renderRow({
      queued: true,
      chain: {
        chainId: 'c',
        rowKey: 'row-1',
        queued: 2,
        total: 2,
        state: 'waiting',
        auto: false,
        destination: { kind: 'me' },
        blocked: { paneKey: session.paneKey!, reason: 'waiting' },
        launchedPaneKeys: [],
        error: null
      }
    })
    expect(document.querySelectorAll('[data-session-status]')).toHaveLength(1)
    expect(screen.getByText('Needs your answer · the plan carries on after')).toBeTruthy()
    expect(screen.queryByText('2 sessions queued')).toBeNull()
    await user.click(details())
    expect(screen.getByText('2 sessions queued')).toBeTruthy()
  })
})

describe('hide and archive on every row', () => {
  it('shows Hide and Archive beside the cancel ✕ on a queued row', () => {
    renderRow({ queued: true })
    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))
    ).toEqual([
      'Open session Make a clock',
      'Hide Make a clock',
      'Archive Make a clock',
      'Tags',
      'Cancel queued session after Make a clock'
    ])
  })

  it('shows Hide and Archive beside the lock on a row a plan launched', () => {
    setSessionChainEntry({
      id: 'chn_source',
      workspacePath: '/workspace',
      worktreeId: session.worktreeId,
      hostId: 'local',
      sourcePaneKey: 'term:tab-0:pane-0',
      sourceRowKey: 'row-0',
      auto: true,
      end: 'done',
      steps: [
        {
          id: 'step_1',
          agent: 'claude',
          prompt: 'Improve',
          status: 'launched',
          launchedPaneKey: session.paneKey
        }
      ],
      currentIndex: 1,
      state: 'waiting',
      createdAt: 1,
      updatedAt: 1
    } as SessionChain)
    publishSessionChains()
    renderRow()
    expect(screen.getByRole('button', { name: 'Hide Make a clock' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Archive Make a clock' })).toBeTruthy()
    expect(
      screen.getByRole('img', {
        name: 'Next step is set · the session ends when it finishes successfully'
      })
    ).toBeTruthy()
  })

  it('hides and archives a queued row from its own buttons', async () => {
    const user = userEvent.setup()
    renderRow({ queued: true })
    await user.click(screen.getByRole('button', { name: 'Archive Make a clock' }))
    expect(useSessionSidebarView.getState().archived).toEqual(['session-1'])
    await user.click(screen.getByRole('button', { name: 'Hide Make a clock' }))
    expect(useSessionSidebarView.getState().view.hidden).toEqual(['conversation:session-1'])
  })
})
