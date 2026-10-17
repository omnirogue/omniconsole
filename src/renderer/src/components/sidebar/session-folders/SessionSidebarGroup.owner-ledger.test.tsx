// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { sessionLensGroupKey } from '@/lib/session-sidebar-lens'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import type { SessionSidebarGroup as GroupModel } from '@/lib/session-sidebar-tree'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { MirroredSidebarConversation } from '@/lib/mirrored-conversation-row-types'
import { ledgerOwner } from '@/lib/mirrored-conversation-test-fixtures'
import { useAppStore } from '@/store'
import type { MirroredConversationOwner } from '@/store/slices/mirrored-conversation-ledger'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/runtime-environments'
import { SessionSidebarGroup } from './SessionSidebarGroup'

vi.mock('@/components/next-step/add-next/AddNextPanels', () => ({
  AddNextPanels: () => <div role="menu">Legacy recipient menu</div>
}))

const STUDIO = 'runtime:env-studio' as const
const initialState = useAppStore.getInitialState()

function ledgerRow(rest: MirroredSidebarConversation['rest']): SidebarSession {
  const key = JSON.stringify([STUDIO, 'ledger', 'repo:/workspace', 'c:0123456789abcdef01234567'])
  return {
    rowKey: key,
    sessionKey: key,
    worktreeId: 'repo:/workspace',
    hostId: STUDIO,
    tabId: null,
    paneKey: null,
    kind: 'terminal',
    label: 'Advertising check',
    workspaceLabel: 'Website',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null,
    mirroredConversation: {
      environmentId: 'env-studio',
      conversation: '0123456789abcdef01234567',
      ownerPaneKey: null,
      ownerTabId: null,
      rest,
      listed: true,
      stale: false,
      ownerState: 'ready'
    }
  }
}

function group(overrides: Partial<GroupModel> = {}, sessions: SidebarSession[] = []): GroupModel {
  return {
    key: sessionLensGroupKey('computer', STUDIO),
    kind: 'computer',
    label: 'Mac Studio',
    rows: sessions.map((session) => ({
      session,
      folderId: null,
      attention: null,
      state: null,
      waitingUntil: null
    })),
    collapsed: false,
    hidden: false,
    attentionCount: 0,
    canReorder: false,
    canHide: false,
    ...overrides
  }
}

function renderGroup(model: GroupModel): void {
  render(
    <TooltipProvider>
      <SessionSidebarGroup
        group={model}
        folders={[]}
        activeTabId={null}
        activeWorktreeId={null}
        queuedRowKeys={new Set<string>()}
        onToggle={vi.fn()}
        onHide={vi.fn()}
        onMoveGroup={vi.fn()}
        onRenameFolder={vi.fn()}
        onDeleteFolder={vi.fn()}
        onOpen={vi.fn()}
        onMoveSessionKey={vi.fn()}
        onCancelQueue={vi.fn()}
      />
    </TooltipProvider>
  )
}

function withOwner(owner: Partial<MirroredConversationOwner>): void {
  useAppStore.setState({
    runtimeEnvironments: [
      { id: 'env-studio', name: 'Mac Studio' } as PublicKnownRuntimeEnvironment
    ],
    mirroredConversationOwnersByEnvironment: {
      'env-studio': ledgerOwner({ environmentId: 'env-studio', ...owner })
    }
  })
}

const stateLine = () => document.querySelector<HTMLElement>('[data-owner-ledger-state]')

beforeEach(() => {
  useAppStore.setState(initialState, true)
  useSessionSidebarView.setState({
    view: emptySessionSidebarView(),
    archived: [],
    loaded: true,
    showHidden: false
  })
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe("a paired owner's ledger state under its computer's heading (G2)", () => {
  it('says nothing while the owner’s list is current', () => {
    withOwner({ state: 'ready' })
    renderGroup(group())
    expect(stateLine()).toBeNull()
  })

  it('names an older OmniConsole that lists no paused or archived conversations', () => {
    withOwner({ state: 'older' })
    renderGroup(group())
    expect(stateLine()?.dataset.ownerLedgerState).toBe('older')
    expect(stateLine()?.textContent).toBe(
      'Older OmniConsole on Mac Studio: paused and archived conversations not listed'
    )
  })

  it('dates rows restored from the last list, and an owner out of reach', () => {
    const asOf = Date.now() - 5 * 60_000
    withOwner({ state: 'stale', asOf })
    renderGroup(group())
    expect(stateLine()?.dataset.ownerLedgerState).toBe('stale')
    expect(stateLine()?.textContent).toMatch(/^As of /)
    cleanup()
    withOwner({ state: 'unreachable', asOf })
    renderGroup(group())
    expect(stateLine()?.textContent).toMatch(/^Can't reach Mac Studio · last listed /)
  })

  it('shows no state line under a heading that is not a paired computer', () => {
    withOwner({ state: 'older' })
    renderGroup(group({ key: sessionLensGroupKey('computer', 'local') }))
    expect(stateLine()).toBeNull()
  })
})

describe('ledger rows and folders in a group (session parity, step 6)', () => {
  it('names a paused or stopped owner conversation with its computer beside its name', () => {
    withOwner({ state: 'ready' })
    renderGroup(group({}, [ledgerRow('asleep')]))
    expect(document.querySelector('[data-session-rest-label]')?.textContent).toBe(
      'paused on Mac Studio'
    )
    cleanup()
    renderGroup(group({}, [ledgerRow('dormant')]))
    expect(document.querySelector('[data-session-rest-label]')?.textContent).toBe(
      'stopped on Mac Studio, not resumable'
    )
    cleanup()
    renderGroup(group({}, [ledgerRow('live')]))
    expect(document.querySelector('[data-session-rest-label]')).toBeNull()
  })

  it('offers no folder controls on an owner folder this computer has not received yet', () => {
    const folder = { id: '00000000-0000-4000-8000-0000000000f1', name: 'Studio only' }
    renderGroup(group({ key: `folder:${folder.id}`, kind: 'folder', label: folder.name, folder }))
    expect(document.querySelector('[data-session-group-actions]')).not.toBeNull()
    cleanup()
    renderGroup(
      group({
        key: `folder:${folder.id}`,
        kind: 'folder',
        label: folder.name,
        folder,
        readOnlyOwnerFolder: true
      })
    )
    expect(document.querySelector('[data-session-group-actions]')).toBeNull()
  })
})
