// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HiddenTabStripPaneControls } from './HiddenTabStripPaneControls'
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({ sidebarOpen: false, rightSidebarOpen: false })
}))
vi.mock('../tab-bar/request-active-terminal-pane-split', () => ({
  requestActiveTerminalPaneSplit: vi.fn()
}))
afterEach(cleanup)

it('reserves both floating chrome gutters and keeps the row draggable around its buttons', () => {
  const view = render(
    <TooltipProvider>
      <HiddenTabStripPaneControls
        terminalTabId="terminal"
        groupId="group"
        worktreeId="workspace"
        tabBar={<span>tab controls</span>}
        paneActions={<span>pane actions</span>}
        reserveCollapsedSidebarHeaderSpace
        reserveClosedExplorerToggleSpace
      />
    </TooltipProvider>
  )
  const row = view.container.querySelector('[data-hidden-tab-strip-controls]')!
  expect(row.getAttribute('data-terminal-focus-release-surface')).toBe('true')
  expect(row.getAttribute('data-tab-group-strip-id')).toBe('group')
  expect(row.getAttribute('data-worktree-id')).toBe('workspace')
  expect(screen.getByText('tab controls')).toBeTruthy()
  expect(screen.getByText('pane actions')).toBeTruthy()
  expect(row.getAttribute('style')).toBeNull()
  expect(row.querySelector('[style*="--collapsed-sidebar-header-width"]')).not.toBeNull()
  expect(row.querySelector('[data-reserve="explorer-toggle"]')).not.toBeNull()
  for (const button of screen.getAllByRole('button')) {
    expect(button.getAttribute('data-no-drag')).toBe('true')
  }
})
