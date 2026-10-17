// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  clearSessionChainEntries,
  publishSessionChains,
  setSessionChainEntry
} from '@/lib/session-chain-registry'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { SessionSidebarRow } from '@/components/sidebar/session-folders/SessionSidebarRow'

vi.mock('@/components/next-step/add-next/AddNextPanels', () => ({
  AddNextPanels: () => <div role="menu">Legacy recipient menu</div>
}))

const PANE = 'term:tab-1:pane-1'

const session: SidebarSession = {
  rowKey: 'row-1',
  sessionKey: 'session-1',
  worktreeId: 'repo:/workspace',
  hostId: 'local',
  tabId: 'term:tab-1',
  paneKey: PANE,
  kind: 'terminal',
  label: 'Build landing page',
  workspaceLabel: 'Website',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}

function setStatus(entry: Partial<AgentStatusEntry> | null): void {
  useAppStore.setState({
    agentStatusEpoch: 1,
    agentStatusByPaneKey: entry
      ? {
          [PANE]: {
            paneKey: PANE,
            state: 'working',
            prompt: '',
            updatedAt: Date.now(),
            stateStartedAt: Date.now() - 60_000,
            stateHistory: [],
            ...entry
          } as AgentStatusEntry
        }
      : {}
  } as never)
}

function launchPlan(): void {
  setSessionChainEntry({
    id: 'chn_row',
    workspacePath: '/workspace',
    worktreeId: session.worktreeId,
    hostId: 'local',
    sourcePaneKey: 'term:tab-0:pane-0',
    sourceRowKey: 'row-0',
    auto: true,
    currentIndex: 2,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps: [
      { id: 's1', agent: 'claude', prompt: 'Build it', status: 'launched' },
      {
        id: 's2',
        agent: 'codex',
        prompt: 'Review it',
        presetId: 'review',
        status: 'launched',
        launchedPaneKey: PANE
      },
      { id: 's3', agent: 'claude', prompt: 'Repair it', status: 'queued' }
    ]
  } as SessionChain)
  publishSessionChains()
}

/** A 180px sidebar: narrower than any real session list column. */
function renderNarrowRow() {
  return render(
    <TooltipProvider>
      <div style={{ width: 180 }}>
        <SessionSidebarRow
          session={session}
          current={false}
          queued={false}
          onOpen={vi.fn()}
          onCancelQueue={vi.fn()}
        />
      </div>
    </TooltipProvider>
  )
}

function rowElement(): HTMLElement {
  return screen.getByRole('button', { name: 'Open session Build landing page' }).parentElement!
}

beforeEach(() => {
  useSessionSidebarView.setState({
    // Why comfortable: these tests read the agent and status lines on the row itself; the
    // default compact row keeps them for its hover card (see SessionSidebarRow.compact.test).
    view: { ...emptySessionSidebarView(), density: 'comfortable' },
    archived: [],
    loaded: true,
    showHidden: false
  })
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
  setStatus(null)
})

afterEach(() => {
  cleanup()
  clearSessionChainEntries()
  publishSessionChains()
  setStatus(null)
})

describe('the session list row indicator', () => {
  it('puts the plan step on the row', () => {
    launchPlan()
    setStatus({ toolName: 'Read', toolInput: 'src/main/index.ts' })
    renderNarrowRow()
    const line = screen.getByText('Step 2 of 3 · 👀 Review · Codex')
    expect(line.getAttribute('data-session-activity-row')).toBe('chain')
    // The full line stays reachable on hover even when the column clips it.
    expect(line.getAttribute('title')).toBe('Step 2 of 3 · 👀 Review · Codex')
  })

  it('otherwise puts what the session is doing now on the row, in one clipped line', () => {
    setStatus({ toolName: 'Edit', toolInput: 'src/renderer/src/components/App.tsx' })
    renderNarrowRow()
    const line = screen.getByText('Editing App.tsx')
    expect(line.getAttribute('data-session-activity-row')).toBe('activity')
    // Why these classes: `block truncate` is one line that clips; anything wrapping would
    // grow the row's height as output arrives, which is the layout shift to avoid.
    expect(line.className.split(' ')).toContain('truncate')
    expect(line.className.split(' ')).toContain('block')
    expect(line.className).not.toContain('whitespace-normal')
  })

  it('does not change the row layout it is added to', () => {
    setStatus(null)
    renderNarrowRow()
    const withoutSignal = rowElement()
    const quietClassName = withoutSignal.className
    const quietTextColumnChildren =
      withoutSignal.querySelector('[data-session-open=""] > span:last-of-type')?.children.length ??
      0
    expect(screen.queryByText('Status unknown')).toBeNull()
    expect(withoutSignal.querySelectorAll('[data-session-activity-row]')).toHaveLength(0)

    cleanup()
    setStatus({ toolName: 'Edit', toolInput: 'src/renderer/src/components/App.tsx' })
    renderNarrowRow()
    const withSignal = rowElement()
    expect(withSignal.className).toBe(quietClassName)
    expect(withSignal.querySelectorAll('[data-session-activity-row]')).toHaveLength(1)
    const textColumn = withSignal.querySelector('[data-session-open=""] > span:last-of-type')
    // Exactly one line more than the quiet row: the indicator, nothing else moved.
    expect(textColumn?.children.length).toBe(quietTextColumnChildren + 1)
  })

  it('stays silent on a finished session that no plan step owns', () => {
    setStatus({ state: 'done', lastAssistantMessage: 'All done' })
    renderNarrowRow()
    expect(screen.queryByText('All done')).toBeNull()
    expect(rowElement().querySelectorAll('[data-session-activity-row]')).toHaveLength(0)
  })
})
