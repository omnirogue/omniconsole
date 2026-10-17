import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TabBarItem } from './tab-bar-item-model'
import type { TabBarProps } from './tab-bar-props'
import type { TabBarRuntimeModel } from './use-tab-bar-runtime-model'
import { renderTabBarItems } from './tab-bar-item-surface'
import { resetTerminalTabActivityFlagsCacheForTest } from './terminal-tab-activity-status'

// Why: the strip's own per-pane status read (agentStatusByPaneKey, fresh entries only)
// drives the dot, so the store is stubbed with real-shaped entries rather than a flag.
const storeState = vi.hoisted(() => ({
  agentStatusByPaneKey: {} as Record<string, AgentStatusEntry>,
  agentStatusEpoch: 0,
  runtimePaneTitlesByTabId: {} as Record<string, Record<number, string>>,
  ptyIdsByTabId: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {} as Record<string, unknown>,
  unreadTerminalTabs: {} as Record<string, boolean>,
  unreadAgentCompletionPanes: {} as Record<string, boolean>,
  renamingTabId: null as string | null,
  setRenamingTabId: vi.fn(),
  openMarkdownPreview: vi.fn(),
  settings: null
}))

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: ({ id }: { id: string }) => ({
    attributes: { role: 'tab', tabIndex: 0, 'data-sortable-id': id },
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn()
  })
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div data-tooltip-root>{children}</div>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-tooltip-content>{children}</div>
  ),
  TooltipTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) =>
    asChild && isValidElement(children) ? (
      cloneElement(children as ReactElement<Record<string, unknown>>, {
        'data-tooltip-trigger': 'true'
      })
    ) : (
      <span data-tooltip-trigger>{children}</span>
    )
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: () => null,
  DropdownMenuItem: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuSeparator: () => null,
  DropdownMenuShortcut: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuLabel: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuSub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuSubContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuSubTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />
}))
vi.mock('../sidebar/WorktreeCardHelpers', () => ({
  FilledBellIcon: () => <span data-filled-bell />
}))
vi.mock('./shell-icons', () => ({ ShellIcon: () => <span data-shell-icon /> }))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span data-agent-catalog-icon={agent} />
}))
vi.mock('@/lib/use-tab-agent', () => ({ useTabAgent: () => null }))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))
vi.mock('@/store/selectors', () => ({
  useRepoById: () => ({ connectionId: null }),
  useWorktreeById: () => ({ path: '/repo', repoId: 'repo-1' })
}))
vi.mock('../browser-pane/describe-page/live-browser-url-registry', () => ({
  getLiveBrowserUrl: () => null
}))
vi.mock('@/lib/file-type-icons', () => ({
  getFileTypeIcon: () =>
    function FileIcon() {
      return <span data-file-icon />
    }
}))
vi.mock('@/lib/rename-file', () => ({ renameFileOnDisk: vi.fn() }))
vi.mock('@/lib/language-detect', () => ({ detectLanguage: () => 'typescript' }))
vi.mock('@/components/editor/markdown-preview-controls', () => ({
  canOpenMarkdownPreview: () => false
}))
vi.mock('@/lib/local-path-open-guard', () => ({ showLocalPathOpenBlockedToast: vi.fn() }))
vi.mock('./editor-tab-local-open-guard', () => ({ shouldBlockEditorTabLocalOpen: () => false }))

const LEAF = '11111111-1111-4111-8111-111111111111'

function terminalItem(id: string, title: string): TabBarItem {
  const data: TerminalTab = {
    id,
    ptyId: null,
    worktreeId: 'wt-1',
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  return { type: 'terminal', id, unifiedTabId: `unified-${id}`, isPinned: false, data }
}

function statusEntry(tabId: string, state: AgentStatusEntry['state']): AgentStatusEntry {
  return {
    paneKey: `${tabId}:${LEAF}`,
    state,
    updatedAt: Date.now()
  } as AgentStatusEntry
}

const RUNTIME = {
  resolvedGroupId: 'group-1',
  generatedTabTitlesEnabled: false,
  unifiedTabByVisibleId: new Map(),
  managedBrowserCreationEnabled: false,
  toggleTabViewMode: () => {},
  statusByRelativePath: new Map()
} as unknown as TabBarRuntimeModel

function renderStrip(items: TabBarItem[]): string {
  const nodes = renderTabBarItems({
    items,
    props: {
      worktreeId: 'wt-1',
      activeTabId: items[0]?.id ?? null,
      activeTabType: 'terminal',
      expandedPaneByTabId: {},
      onActivate: vi.fn(),
      onClose: vi.fn(),
      onCloseOthers: vi.fn(),
      onCloseToRight: vi.fn(),
      onCloseToLeft: vi.fn(),
      onSetCustomTitle: vi.fn(),
      onSetTabColor: vi.fn(),
      onTogglePaneExpand: vi.fn()
    } as unknown as TabBarProps,
    runtime: RUNTIME,
    dropIndicatorByVisibleId: new Map(),
    includeTopTabBorder: true,
    activeClientHostedBrowserRowId: null,
    togglePinned: () => {}
  })
  return renderToStaticMarkup(<>{nodes}</>)
}

function tabMarkup(markup: string, tabId: string): string {
  const start = markup.indexOf(`data-tab-id="${tabId}"`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = markup.indexOf('data-tab-id="', start + 1)
  return end === -1 ? markup.slice(start) : markup.slice(start, end)
}

beforeEach(() => {
  storeState.agentStatusByPaneKey = {}
  storeState.agentStatusEpoch += 1
  resetTerminalTabActivityFlagsCacheForTest()
})

describe('TabBar family labels and state dot', () => {
  it('shows the run number tail for three "Advertising run NNN" tabs and dots their state', () => {
    storeState.agentStatusByPaneKey = {
      [`ads-255:${LEAF}`]: statusEntry('ads-255', 'working'),
      [`ads-161:${LEAF}`]: statusEntry('ads-161', 'blocked')
    }
    const markup = renderStrip([
      terminalItem('ads-255', 'Advertising run 255'),
      terminalItem('ads-161', 'Advertising run 161'),
      terminalItem('ads-98', 'Advertising run 98')
    ])

    const running = tabMarkup(markup, 'ads-255')
    expect(running).toContain('>Adv…255</span>')
    expect(running).toContain(
      '<span class="min-w-0 flex-1 truncate mr-1" title="Advertising run 255"'
    )
    expect(running).toContain('aria-label="Advertising run 255 · running"')
    expect(running).toContain('data-tab-state="running"')
    expect(running).toContain('bg-status-info')
    expect(running).toContain('motion-safe:animate-pulse')

    const needsYou = tabMarkup(markup, 'ads-161')
    expect(needsYou).toContain('>Adv…161</span>')
    expect(needsYou).toContain('aria-label="Advertising run 161 · needs you"')
    expect(needsYou).toContain('data-tab-state="needs-you"')
    expect(needsYou).toContain('bg-status-warning')
    expect(needsYou).not.toContain('animate-pulse')

    const idle = tabMarkup(markup, 'ads-98')
    expect(idle).toContain('>Adv…98</span>')
    expect(idle).toContain('aria-label="Advertising run 98"')
    expect(idle).not.toContain('data-testid="tab-state-dot"')
  })

  it('keeps end truncation (full text, CSS truncate) for a lone tab', () => {
    const markup = renderStrip([terminalItem('ads-255', 'Advertising run 255')])
    const tab = tabMarkup(markup, 'ads-255')
    expect(tab).toContain('>Advertising run 255</span>')
    expect(tab).not.toContain('…')
    expect(tab).toContain('truncate')
    expect(tab).toContain('<span class="min-w-0 flex-1 truncate mr-1" data-tooltip-trigger')
    expect(tab).not.toContain('data-testid="tab-state-dot"')
  })

  it('keeps end truncation when only two tabs share the prefix', () => {
    const markup = renderStrip([
      terminalItem('ads-255', 'Advertising run 255'),
      terminalItem('ads-161', 'Advertising run 161'),
      terminalItem('term-1', 'Terminal 1')
    ])
    expect(tabMarkup(markup, 'ads-255')).toContain('>Advertising run 255</span>')
    expect(tabMarkup(markup, 'term-1')).toContain('>Terminal 1</span>')
  })
})
