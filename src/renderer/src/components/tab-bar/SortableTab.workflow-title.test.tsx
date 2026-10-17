// @vitest-environment happy-dom
import type { ReactElement, ReactNode } from 'react'
import { cloneElement, isValidElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import SortableTab from './SortableTab'

const state = vi.hoisted(() => ({
  unreadTerminalTabs: {},
  unreadAgentCompletionPanes: {},
  agentStatusByPaneKey: {},
  agentStatusEpoch: 0,
  runtimePaneTitlesByTabId: {},
  ptyIdsByTabId: {},
  terminalLayoutsByTabId: {},
  renamingTabId: null,
  setRenamingTabId: () => {}
}))
// Both specifiers resolve to the one store module; the tab only reads it through selectors.
vi.mock('../../store', () => ({
  useAppStore: (select: (value: typeof state) => unknown) => select(state)
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (value: typeof state) => unknown) => select(state)
}))
vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {} })
}))
vi.mock('@/lib/use-tab-agent', () => ({ useTabAgent: () => null }))
vi.mock('./use-local-workflow-tab-status', () => ({ useLocalWorkflowTabStatus: () => null }))
vi.mock('./TerminalTabLeadingIcon', () => ({ TerminalTabLeadingIcon: () => null }))
vi.mock('./SortableTabContextMenu', () => ({ SortableTabContextMenu: () => null }))
vi.mock('./SortableTabCloseButton', () => ({ SortableTabCloseButton: () => null }))
// Only the strip label renders: the tooltip, which always holds the full title, is left out.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) =>
    isValidElement(children) ? cloneElement(children as ReactElement) : <>{children}</>
}))

afterEach(cleanup)

function Tab({ tab, siblings }: { tab: TerminalTab; siblings: readonly string[] }) {
  return (
    <SortableTab
      tab={tab}
      unifiedTabId="unified-1"
      groupId="group-1"
      tabCount={siblings.length}
      hasTabsToRight={false}
      hasTabsToLeft={false}
      isActive={false}
      isPinned={false}
      isExpanded={false}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onCloseOthers={vi.fn()}
      onCloseToRight={vi.fn()}
      onCloseToLeft={vi.fn()}
      onSetCustomTitle={vi.fn()}
      onSetTabColor={vi.fn()}
      onTogglePin={vi.fn()}
      onToggleExpand={vi.fn()}
      dragData={{
        kind: 'tab',
        worktreeId: 'wt-1',
        groupId: 'group-1',
        unifiedTabId: 'unified-1',
        visibleTabId: 'tab-1',
        tabType: 'terminal',
        label: tab.title
      }}
      dropIndicator={null}
      siblingTitles={siblings}
    />
  )
}

// Why: live acceptance showed three Build + Review drafts in the strip as "Bui…Review".
it('keeps the start of a workflow tab title where a terminal family keeps its tail', () => {
  const siblings = ['Build + Review', 'Build + Review', 'Build + Review']
  const base = {
    id: 'tab-1',
    title: 'Build + Review',
    worktreeId: 'wt-1',
    ptyId: null,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  } satisfies TerminalTab
  const { rerender } = render(
    <Tab
      tab={{ ...base, localWorkflow: { preset: 'build-review', prompt: '' } }}
      siblings={siblings}
    />
  )
  expect(screen.getByText('Build + Review')).toBeTruthy()
  expect(screen.queryByText('Bui…Review')).toBeNull()
  rerender(<Tab tab={base} siblings={siblings} />)
  expect(screen.getByText('Bui…Review')).toBeTruthy()
})
