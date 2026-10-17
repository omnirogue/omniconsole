// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import type { SessionSidebarGroup as GroupModel } from '@/lib/session-sidebar-tree'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { SESSION_ROW_DRAG_TYPE } from '../../../../../shared/session-sidebar-drag-types'
import { SessionSidebarGroup } from './SessionSidebarGroup'
import {
  beginLaunchIntentDrag,
  clearLaunchIntentDrag,
  LAUNCH_INTENT_DRAG_TYPE
} from '@/lib/launcher-intent-drag'
import { useLaunchContext } from './new-conversation/launch-context'

vi.mock('@/components/next-step/add-next/AddNextPanels', () => ({
  AddNextPanels: () => <div role="menu">Legacy recipient menu</div>
}))

function session(id: string): SidebarSession {
  return {
    rowKey: `row-${id}`,
    sessionKey: `session-${id}`,
    worktreeId: 'repo:/workspace',
    hostId: 'local',
    tabId: `term:tab-${id}`,
    paneKey: `term:tab-${id}:pane-1`,
    kind: 'terminal',
    label: `Session ${id}`,
    workspaceLabel: 'Website',
    agent: 'codex',
    unavailable: false,
    folderKeyMigration: null
  }
}

function group(
  kind: GroupModel['kind'],
  ids: string[],
  folderId: string | null = null
): GroupModel {
  return {
    key: `${kind}:one`,
    kind,
    label: kind === 'task' ? 'Launch the site' : 'Website',
    rows: ids.map((id) => ({
      session: session(id),
      folderId,
      attention: null,
      state: null,
      waitingUntil: null
    })),
    collapsed: false,
    hidden: false,
    attentionCount: 0,
    canReorder: false,
    canHide: false
  }
}

function renderGroup(overrides: Partial<React.ComponentProps<typeof SessionSidebarGroup>>) {
  const props: React.ComponentProps<typeof SessionSidebarGroup> = {
    group: group('folder', ['a']),
    folders: [],
    activeTabId: null,
    activeWorktreeId: null,
    queuedRowKeys: new Set<string>(),
    onToggle: vi.fn(),
    onHide: vi.fn(),
    onMoveGroup: vi.fn(),
    onRenameFolder: vi.fn(),
    onDeleteFolder: vi.fn(),
    onOpen: vi.fn(),
    onMoveSessionKey: vi.fn(),
    onCancelQueue: vi.fn(),
    ...overrides
  }
  render(
    <TooltipProvider>
      <SessionSidebarGroup {...props} />
    </TooltipProvider>
  )
  return props
}

function dropRowOn(element: Element, sessionKey: string): void {
  fireEvent.drop(element, {
    dataTransfer: { types: [SESSION_ROW_DRAG_TYPE], getData: () => sessionKey }
  })
}

beforeEach(() => {
  useSessionSidebarView.setState({
    view: emptySessionSidebarView(),
    archived: [],
    loaded: true,
    showHidden: false
  })
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
})

afterEach(cleanup)

describe('windowed extra rows', () => {
  it('renders only the fleet receipts inside the window, not all of them', () => {
    const renderExtraRow = vi.fn((index: number) => <div data-testid={`fleet-${index}`} />)
    renderGroup({
      group: group('waiting', []),
      extraRowCount: 500,
      renderExtraRow,
      measure: vi.fn(),
      window: {
        header: 0,
        rows: [],
        extra: [
          { index: 5, extraIndex: 3, extraKey: 'wf-three' },
          { index: 6, extraIndex: 4, extraKey: 'wf-four' }
        ],
        end: 6
      }
    })
    expect(document.querySelectorAll('[data-testid^="fleet-"]')).toHaveLength(2)
    expect(screen.getByTestId('fleet-3')).toBeTruthy()
    expect(screen.getByTestId('fleet-4')).toBeTruthy()
    expect(renderExtraRow.mock.calls.map(([index]) => index)).toEqual([3, 4])
  })
})

describe('dropping one conversation on another', () => {
  it("files it into the target row's folder inside a folder group", () => {
    const props = renderGroup({ group: group('folder', ['a', 'b'], 'folder-1') })
    dropRowOn(document.querySelector('[data-session-row="row-b"]')!, 'session-a')
    expect(props.onMoveSessionKey).toHaveBeenCalledExactlyOnceWith('session-a', 'folder-1')
  })

  it('changes no folder inside a task group, whose rows come from several folders', () => {
    // Why: the task group shows rows from every folder, so "next to that one" names no folder
    // the person can see — the old handler silently refiled the session into a hidden one.
    const props = renderGroup({ group: group('task', ['a', 'b'], 'folder-1') })
    dropRowOn(document.querySelector('[data-session-row="row-b"]')!, 'session-a')
    expect(props.onMoveSessionKey).not.toHaveBeenCalled()
    expect(useSessionSidebarView.getState().view.rowOrder ?? []).toEqual([])
  })
})

describe('folder header', () => {
  it('counts working conversations while the folder is open, not only when folded', () => {
    const open = group('folder', ['a', 'b', 'c'])
    open.rows[0].pursuitState = 'working'
    open.rows[1].pursuitState = 'running'
    renderGroup({ group: open })
    const badge = document.querySelector('[data-session-group-active-count]')
    expect(badge?.getAttribute('data-session-group-active-count')).toBe('2')
    expect(screen.getByLabelText('2 working')).toBeTruthy()
  })

  it('sums up a folder in one muted line with a proportional strip, and names its launch on hover', () => {
    const folder = { id: '00000000-0000-4000-8000-000000000002', name: 'Launch · 09:25 · Fix PDF' }
    const batch = {
      ...group('folder', ['a', 'b'], folder.id),
      folder,
      attentionCount: 1,
      folderTally: {
        working: 3,
        needsYou: 1,
        waiting: 1,
        stopped: 0,
        cantSee: 1,
        done: 2,
        total: 8
      },
      batchOrigin: { requestExcerpt: 'fix PDF export, Refer & Earn copy', createdAt: 0 }
    }
    renderGroup({ group: batch, folders: [folder] })
    const tally = document.querySelector('[data-session-folder-tally]')!
    expect(tally.textContent).toBe("3 working · 1 needs you · 1 waiting · 1 can't see · 2/8 done")
    expect(document.querySelector('[data-session-group-active-count]')).toBeNull()
    expect(document.querySelector('[data-session-group-attention-count]')).toBeNull()
    const widths = [
      ...document.querySelectorAll<HTMLElement>('[data-session-folder-strip-state]')
    ].map((part) => [part.dataset.sessionFolderStripState, part.style.width])
    expect(widths).toEqual([
      ['needsYou', '12.5%'],
      ['working', '37.5%'],
      ['waiting', '12.5%'],
      ['cantSee', '12.5%'],
      ['done', '25%']
    ])
    expect(screen.getByText('Website').getAttribute('title')).toContain(
      'from: “fix PDF export, Refer & Earn copy”'
    )
  })

  it('offers a saved folder its own + as well', () => {
    const folder = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Done work',
      section: 'saved' as const
    }
    const saved = { ...group('folder', ['a'], folder.id), folder }
    const folderLauncher = vi.fn(() => <button type="button">launch here</button>)
    renderGroup({ group: saved, folders: [folder], folderLauncher })
    expect(folderLauncher).toHaveBeenCalledWith(folder, 'Website')
    expect(screen.getByRole('button', { name: 'launch here' })).toBeTruthy()
  })
})

it('accepts a palette drop on the folder heading and queues its own launcher', () => {
  const folder = { id: 'folder-launch', name: 'Launches' }
  useLaunchContext.setState({ target: undefined, pendingLaunch: undefined })
  const target = { ...group('folder', [], folder.id), folder }
  renderGroup({ group: target, folders: [folder], folderLauncher: () => <button>Folder +</button> })
  const header = screen.getByRole('button', { name: 'Collapse Website' }).parentElement!
  const dataTransfer = {
    types: [LAUNCH_INTENT_DRAG_TYPE],
    setData: vi.fn(),
    getData: () => '{"agent":"codex"}'
  }
  beginLaunchIntentDrag(dataTransfer, { agent: 'codex' })
  fireEvent.dragOver(header, { dataTransfer })
  expect(header.dataset.launchDragOver).toBe('true')
  fireEvent.drop(header, { dataTransfer })
  expect(useLaunchContext.getState().target).toBeUndefined()
  expect(useLaunchContext.getState().pendingLaunch).toEqual(
    expect.objectContaining({ pick: { agent: 'codex' }, folderId: folder.id, target: undefined })
  )
  clearLaunchIntentDrag()
})

it('accepts a palette drop on a session row and selects its workspace', () => {
  useLaunchContext.setState({ target: undefined, pendingLaunch: undefined })
  renderGroup({ group: group('workspace', ['a']) })
  const row = document.querySelector('[data-session-row="row-a"]')!
  const dataTransfer = {
    types: [LAUNCH_INTENT_DRAG_TYPE],
    setData: vi.fn(),
    getData: () => '{"agent":"claude"}'
  }
  beginLaunchIntentDrag(dataTransfer, { agent: 'claude' })
  fireEvent.dragOver(row, { dataTransfer })
  expect(row.parentElement?.dataset.dragOver).toBe('true')
  fireEvent.drop(row, { dataTransfer })
  expect(useLaunchContext.getState().target).toEqual({
    kind: 'workspace',
    worktreeId: 'repo:/workspace'
  })
  expect(useLaunchContext.getState().pendingLaunch?.pick).toEqual({ agent: 'claude' })
  clearLaunchIntentDrag()
})
