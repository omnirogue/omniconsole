import type { ReactNode } from 'react'
import { useAppStore } from '@/store'
import { PanelBottomClose, PanelRightClose } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { requestActiveTerminalPaneSplit } from '../tab-bar/request-active-terminal-pane-split'
import { useSessionWorkIndicatorReserve } from '@/components/right-sidebar/session-artifact/session-work-view-store'

const buttonClassName =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

/** Keeps split actions reachable when a lone conversation hides the strip. */
export function HiddenTabStripPaneControls({
  terminalTabId,
  groupId,
  worktreeId,
  tabBar,
  paneActions,
  reserveCollapsedSidebarHeaderSpace,
  reserveClosedExplorerToggleSpace
}: {
  groupId: string
  worktreeId: string
  tabBar: ReactNode
  paneActions: ReactNode
  terminalTabId: string
  reserveCollapsedSidebarHeaderSpace: boolean
  reserveClosedExplorerToggleSpace: boolean
}): React.JSX.Element {
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const rightSidebarOpen = useAppStore((state) => state.rightSidebarOpen)
  const indicatorReserve = useSessionWorkIndicatorReserve()
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties
  const splitRightLabel = translate(
    'auto.components.tab.bar.SortableTabContextMenu.splitTerminalRight',
    'Split terminal right'
  )
  const splitDownLabel = translate(
    'auto.components.tab.bar.SortableTabContextMenu.splitTerminalDown',
    'Split terminal down'
  )
  return (
    <div
      className="flex h-8 shrink-0 items-center justify-start gap-0.5 border-b bg-card pr-1.5"
      data-tab-group-strip-id={groupId}
      data-worktree-id={worktreeId}
      data-terminal-focus-release-surface="true"
      data-hidden-tab-strip-controls={terminalTabId}
    >
      {reserveCollapsedSidebarHeaderSpace && !sidebarOpen ? (
        <div
          className="shrink-0"
          data-reserve="sidebar-header"
          style={{ ...noDrag, width: 'var(--collapsed-sidebar-header-width)' }}
        />
      ) : null}
      <div className="min-w-0 flex-1 h-full">{tabBar}</div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-no-drag="true"
            style={noDrag}
            aria-label={splitRightLabel}
            className={buttonClassName}
            onClick={() => {
              requestActiveTerminalPaneSplit({ tabId: terminalTabId, direction: 'vertical' })
            }}
          >
            <PanelRightClose className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {splitRightLabel}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-no-drag="true"
            style={noDrag}
            aria-label={splitDownLabel}
            className={buttonClassName}
            onClick={() => {
              requestActiveTerminalPaneSplit({ tabId: terminalTabId, direction: 'horizontal' })
            }}
          >
            <PanelBottomClose className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {splitDownLabel}
        </TooltipContent>
      </Tooltip>
      {paneActions}
      {reserveClosedExplorerToggleSpace ? (
        <div
          className="shrink-0"
          data-reserve="explorer-toggle"
          data-reserve-collapsed={!rightSidebarOpen}
          style={{
            ...noDrag,
            width: `calc(${rightSidebarOpen ? 36 : 76 + indicatorReserve}px + var(--window-controls-width, 0px))`
          }}
        />
      ) : null}
    </div>
  )
}
