// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPaneCard, AttentionPane } from '@/components/attention/agent-pane-snapshot'
import type { ConversationFleetSidebarGroup } from '@/lib/conversation-fleet-sidebar'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { SESSION_FOCUS_NEEDS_YOU_KEY } from '@/lib/session-focus-lines'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import {
  createLocalSessionSidebarViewStorage,
  SESSION_SIDEBAR_VIEW_STORAGE_KEY
} from '@/lib/session-sidebar-view-storage'
import { personalViewStorageKey } from '@/lib/personal-view-storage'
import { buildSessionSidebarTree } from '@/lib/session-sidebar-tree'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { createSessionSidebarViewStore, useSessionSidebarView } from '@/store/session-sidebar-view'
import { SessionFocusView } from './SessionFocusView'
import {
  SESSION_FOCUS_DRILL_IDLE_MS,
  useSessionFocusDrill,
  useSessionFocusView
} from './use-session-focus-view'

const now = 1_000_000_000_000
const FOLDER = '00000000-0000-4000-8000-000000000001'

function session(key: string): SidebarSession {
  return {
    rowKey: key,
    sessionKey: key,
    worktreeId: 'w1',
    hostId: 'local',
    tabId: `tab-${key}`,
    paneKey: `tab-${key}:leaf`,
    kind: 'terminal',
    label: `Session ${key}`,
    workspaceLabel: 'Website / main',
    agent: 'codex',
    unavailable: false,
    folderKeyMigration: null
  }
}

function card(key: string, dotState: AgentPaneCard['dotState'], age = 1000): AgentPaneCard {
  return {
    paneKey: `tab-${key}:leaf`,
    worktreeId: 'w1',
    tabId: `tab-${key}`,
    leafId: 'leaf',
    agentType: 'codex',
    bucket: dotState === 'working' ? 'working' : 'idle',
    dotState,
    unseen: false,
    title: key,
    stateChangedAt: now - age,
    repoName: 'Website',
    worktreeName: 'main'
  } as AgentPaneCard
}

/** Sessions `w0…` work in one folder, `q0…` ask (q3 has waited longest), the rest are idle. */
function groups(input: { working: number; asking: number; idle: number }) {
  const working = Array.from({ length: input.working }, (_, index) => `w${index}`)
  const asking = Array.from({ length: input.asking }, (_, index) => `q${index}`)
  const idle = Array.from({ length: input.idle }, (_, index) => `i${index}`)
  return buildSessionSidebarTree({
    now,
    sessions: [...working, ...asking, ...idle].map(session),
    metadata: {
      ...emptySessionFolderMetadata(),
      folders: [{ id: FOLDER, name: 'Launch site' }],
      membership: Object.fromEntries(working.map((key) => [key, FOLDER]))
    },
    view: emptySessionSidebarView(),
    snapshot: {
      cardsByPaneKey: new Map(working.map((key) => [`tab-${key}:leaf`, card(key, 'working')])),
      cardsByTabId: new Map(),
      attentionByPaneKey: new Map<string, AttentionPane>(
        asking.map((key, index) => [
          `tab-${key}:leaf`,
          {
            ...card(key, 'waiting', index === 3 ? 90_000 : 1000 + index),
            bucket: 'attention',
            cause: 'waiting',
            portalPaneKey: `tab-${key}:leaf`,
            askSummary: `Approve step ${index}?`
          } as AttentionPane
        ])
      )
    },
    query: '',
    showHidden: false,
    showArchived: false,
    archivedKeys: new Set()
  }).groups.map((group): ConversationFleetSidebarGroup => ({ ...group, fleetRows: [] }))
}

function Harness({ tree }: { tree: ConversationFleetSidebarGroup[] }): React.JSX.Element {
  const focus = useSessionFocusView({
    groups: tree,
    listGroups: tree,
    technical: false,
    query: '',
    now
  })
  const listRef = useRef<HTMLDivElement>(null)
  return (
    <SessionFocusView focus={focus} listRef={listRef} onKeyDown={() => {}}>
      {focus.listGroups.map((group) => (
        <div key={group.key} role="group" aria-label={group.label} data-session-group={group.key}>
          <button type="button" aria-expanded onClick={() => focus.handleToggle(group.key)}>
            {`Collapse ${group.label}`}
          </button>
          {group.rows.map((row) => (
            <div key={row.session.rowKey} role="option" aria-selected={false}>
              {row.session.label}
            </div>
          ))}
        </div>
      ))}
    </SessionFocusView>
  )
}

const lines = () => document.querySelectorAll('[data-session-focus-line]')
const storedLayout = () =>
  JSON.parse(localStorage.getItem(personalViewStorageKey(SESSION_SIDEBAR_VIEW_STORAGE_KEY)) ?? '{}')
    .layout

beforeEach(() => {
  localStorage.clear()
  useSessionSidebarView.setState({
    view: { ...emptySessionSidebarView(), flat: false },
    loaded: true
  })
  useSessionFocusDrill.setState({ drilled: false })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SessionFocusView', () => {
  it('keeps 100 sessions to at most five lines by default, with no tree rows', () => {
    render(<Harness tree={groups({ working: 30, asking: 8, idle: 62 })} />)
    expect(lines().length).toBeLessThanOrEqual(5)
    expect(screen.queryAllByRole('option')).toEqual([])
    expect(
      screen.getByRole('button', { name: 'Needs you: 8. Most urgent: Approve step 3?' })
    ).toBeTruthy()
    expect(screen.getByText('Needs you · 8')).toBeTruthy()
    const folder = document.querySelector(`[data-session-focus-folder="folder:${FOLDER}"]`)!
    expect(folder.textContent).toContain('Launch site')
    expect(folder.textContent).toContain('30 working')
  })

  it('opens questions five at a time and folds them back from the heading', async () => {
    const user = userEvent.setup()
    render(<Harness tree={groups({ working: 2, asking: 8, idle: 3 })} />)
    await user.click(screen.getByRole('button', { name: /^Needs you: 8/ }))
    const opened = screen.getByRole('group', { name: 'Needs you' })
    expect(opened.getAttribute('data-session-group')).toBe(SESSION_FOCUS_NEEDS_YOU_KEY)
    expect(screen.getAllByRole('option').map((row) => row.textContent)[0]).toBe('Session q3')
    expect(screen.getAllByRole('option')).toHaveLength(5)
    expect(screen.queryByRole('button', { name: /^Needs you: 8/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Show 3 more' }))
    expect(screen.getAllByRole('option')).toHaveLength(8)
    expect(screen.queryByRole('button', { name: /^Show \d+ more/ })).toBeNull()
    // Why the heading: the opened list's own heading is the way back, focus returns to the line.
    await user.click(screen.getByRole('button', { name: 'Collapse Needs you' }))
    expect(screen.queryAllByRole('option')).toEqual([])
    expect(screen.getByRole('button', { name: /^Needs you: 8/ })).toBeTruthy()
    // Why: reopening starts from five again.
    await user.click(screen.getByRole('button', { name: /^Needs you: 8/ }))
    expect(screen.getAllByRole('option')).toHaveLength(5)
  })

  it('shows only Everything else on a quiet day', () => {
    render(<Harness tree={groups({ working: 0, asking: 0, idle: 6 })} />)
    expect([...lines()].map((line) => line.textContent)).toEqual(['Everything else · 6 sessions'])
  })

  it('opens the full tree for now and back, leaving the device on Focus', async () => {
    const user = userEvent.setup()
    render(<Harness tree={groups({ working: 2, asking: 1, idle: 3 })} />)
    await user.click(screen.getByRole('button', { name: /^Everything else/ }))
    expect(lines().length).toBe(0)
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
    expect(storedLayout()).not.toBe('full')
    expect(document.activeElement?.hasAttribute('data-session-focus-back')).toBe(true)

    const reloaded = createSessionSidebarViewStore(createLocalSessionSidebarViewStorage())
    reloaded.getState().load()
    expect(reloaded.getState().view.layout).not.toBe('full')

    await user.click(screen.getByRole('button', { name: 'Back to focus view' }))
    expect(storedLayout()).not.toBe('full')
    expect(screen.queryAllByRole('option')).toEqual([])
    await act(async () => {})
    expect(document.activeElement?.hasAttribute('data-session-focus-everything-else')).toBe(true)
  })

  it('opens a folder line into the full tree with that folder unfolded, for now only', async () => {
    const user = userEvent.setup()
    render(<Harness tree={groups({ working: 2, asking: 0, idle: 1 })} />)
    await user.click(screen.getByText('Launch site'))
    expect(lines().length).toBe(0)
    expect(useSessionSidebarView.getState().view.layout).not.toBe('full')
    expect(useSessionSidebarView.getState().view.collapsed).toContain(`folder:${FOLDER}:open`)
  })

  it('returns to Focus on its own after an idle minute, and stays while the list is used', () => {
    vi.useFakeTimers()
    render(<Harness tree={groups({ working: 2, asking: 0, idle: 1 })} />)
    fireEvent.click(screen.getByText('Launch site'))
    expect(lines().length).toBe(0)
    act(() => vi.advanceTimersByTime(SESSION_FOCUS_DRILL_IDLE_MS - 1000))
    fireEvent.pointerMove(screen.getByRole('listbox'))
    act(() => vi.advanceTimersByTime(SESSION_FOCUS_DRILL_IDLE_MS - 1000))
    expect(lines().length).toBe(0)
    act(() => vi.advanceTimersByTime(1000))
    expect(lines().length).toBeGreaterThan(0)
    expect(useSessionFocusDrill.getState().drilled).toBe(false)
  })

  it('keeps Folders when the person picked it, with Back to focus view as a shortcut', async () => {
    const user = userEvent.setup()
    useSessionSidebarView.getState().setViewChoice('folders')
    render(<Harness tree={groups({ working: 2, asking: 0, idle: 1 })} />)
    expect(lines().length).toBe(0)
    expect(storedLayout()).toBe('full')
    await user.click(screen.getByRole('button', { name: 'Back to focus view' }))
    expect(storedLayout()).toBe('focus')
    expect(lines().length).toBeGreaterThan(0)
  })
})
