import { subscribeSessionGridPaneFlash } from '@/lib/session-grid-pane-flash'
import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import {
  ArrowUpRight,
  Globe,
  GripVertical,
  Minus,
  NotebookPen,
  SquareTerminal,
  X,
  Maximize2,
  Minimize2,
  LayoutDashboard
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { beginSessionGridDrag, clearSessionGridDrag } from '@/lib/session-grid-drag'
import { PaneContentMenu } from './PaneContentMenu'
import { PaneFocusContext, type PaneFocus } from '@/components/pane-focus-context'
import { cn } from '@/lib/utils'
import type { SessionGridPane } from '@/lib/session-grid-panes'

const KIND_ICON = {
  session: SquareTerminal,
  browser: Globe,
  notepad: NotebookPen
} as const

/**
 * One pane of the Grid: a header strip (drag handle, name, where it lives, open / minimize /
 * close) over whatever the pane shows. The focused pane wears the ring.
 */
export function SessionGridPaneFrame(props: {
  pane: SessionGridPane
  label: React.ReactNode
  detail?: string | null
  focused: boolean
  onFocus: () => void
  onOpen?: () => void
  onMinimize: () => void
  onChooseContent?: (id: string) => void
  onToggleMaximize?: () => void
  maximized?: boolean
  paneFocus?: PaneFocus
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const { pane, focused, onFocus } = props
  const [flashing, setFlashing] = useState(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeSessionGridPaneFlash((id) => {
      if (id !== pane.id) {
        return
      }
      setFlashing(true)
      clearTimeout(timer)
      timer = setTimeout(() => setFlashing(false), 700)
    })
    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [pane.id])
  const frameRef = useRef<HTMLElement>(null)
  const latestFocus = useRef(onFocus)
  useLayoutEffect(() => {
    latestFocus.current = onFocus
  })
  // Why native listeners: a borrowed terminal renders through a React portal, so its pointer
  // events bubble through the Terminal tree, never through this frame's React handlers.
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) {
      return
    }
    const focus = (): void => latestFocus.current()
    frame.addEventListener('pointerdown', focus, true)
    frame.addEventListener('focusin', focus)
    return () => {
      frame.removeEventListener('pointerdown', focus, true)
      frame.removeEventListener('focusin', focus)
    }
  }, [])
  const Icon =
    pane.kind === 'view' || pane.kind === 'unavailable' ? LayoutDashboard : KIND_ICON[pane.kind]
  return (
    <section
      ref={frameRef}
      data-session-grid-pane={pane.id}
      data-session-grid-pane-flashing={flashing ? '' : undefined}
      data-session-grid-pane-kind={pane.kind}
      data-session-grid-pane-focused={focused ? '' : undefined}
      className={cn(
        'flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-md border bg-background',
        flashing
          ? 'ring-2 ring-primary motion-safe:animate-pulse'
          : focused
            ? 'border-ring/70 ring-1 ring-ring/40'
            : 'border-border'
      )}
    >
      <header
        onDoubleClick={(event) => {
          if (!(event.target as HTMLElement).closest('button, input, [role=button]')) {
            props.onToggleMaximize?.()
          }
        }}
        draggable
        onDragStart={(event) =>
          beginSessionGridDrag(event.dataTransfer, { kind: 'pane', paneId: pane.id })
        }
        onDragEnd={clearSessionGridDrag}
        className={cn(
          'flex h-8 shrink-0 cursor-grab items-center gap-1.5 border-b border-border px-1.5 active:cursor-grabbing',
          focused ? 'bg-accent/60' : 'bg-muted/30'
        )}
        title={translate('sessionGrid.dragPane', 'Drag to move this pane')}
      >
        <GripVertical className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden strokeWidth={1.75} />
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-[12px] font-medium">{props.label}</span>
          {props.detail ? (
            <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground">
              {props.detail}
            </span>
          ) : null}
        </div>
        {props.onChooseContent ? <PaneContentMenu onPick={props.onChooseContent} /> : null}
        {props.onToggleMaximize ? (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={props.onToggleMaximize}
            aria-label={
              props.maximized
                ? translate('commandCenter.restoreSize', 'Restore pane size')
                : translate('commandCenter.maximize', 'Maximize pane')
            }
            title={
              props.maximized
                ? translate('commandCenter.restoreSize', 'Restore pane size')
                : translate('commandCenter.maximize', 'Maximize pane')
            }
          >
            {props.maximized ? (
              <Minimize2 className="size-3.5" />
            ) : (
              <Maximize2 className="size-3.5" />
            )}
          </Button>
        ) : null}
        {props.onOpen ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            aria-label={translate('sessionGrid.openInWorkspace', 'Open in its workspace')}
            title={translate('sessionGrid.openInWorkspace', 'Open in its workspace')}
            onClick={props.onOpen}
          >
            <ArrowUpRight className="size-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={translate('sessionGrid.minimize', 'Minimize')}
          title={translate('sessionGrid.minimize', 'Minimize')}
          onClick={props.onMinimize}
        >
          <Minus className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={translate('sessionGrid.closePane', 'Close pane')}
          title={translate('sessionGrid.closePaneHint', 'Close pane (the session keeps running)')}
          onClick={props.onClose}
        >
          <X className="size-3.5" />
        </Button>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {props.paneFocus ? (
          <PaneFocusContext.Provider value={props.paneFocus}>
            {props.children}
          </PaneFocusContext.Provider>
        ) : (
          props.children
        )}
      </div>
    </section>
  )
}
