import {
  Globe,
  LayoutGrid,
  LayoutTemplate,
  NotebookPen,
  SquareTerminal,
  X,
  LayoutDashboard
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { beginSessionGridDrag, clearSessionGridDrag } from '@/lib/session-grid-drag'
import { SESSION_GRID_MAX_PANES, type SessionGridLayout } from '@/lib/session-grid-layout'
import type { SessionGridPreset } from '@/lib/session-grid-presets'
import type { SessionGridPane } from '@/lib/session-grid-panes'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { SessionGridAddMenu } from './SessionGridAddMenu'
import { SessionGridLayoutPicker } from './SessionGridLayoutPicker'

const KIND_ICON = { session: SquareTerminal, browser: Globe, notepad: NotebookPen } as const

/** A minimized pane: click brings it back, drag places it, × lets it go. */
function TrayChip(props: {
  pane: SessionGridPane
  label: string
  onRestore: () => void
  onDiscard: () => void
}): React.JSX.Element {
  const Icon =
    props.pane.kind === 'view' || props.pane.kind === 'unavailable'
      ? LayoutDashboard
      : KIND_ICON[props.pane.kind]
  return (
    <span
      draggable
      onDragStart={(event) =>
        beginSessionGridDrag(event.dataTransfer, { kind: 'tray', paneId: props.pane.id })
      }
      onDragEnd={clearSessionGridDrag}
      data-session-grid-tray-pane={props.pane.id}
      className="group/chip inline-flex max-w-44 shrink-0 cursor-grab items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pl-2 pr-0.5 text-[11px] active:cursor-grabbing"
    >
      <button
        type="button"
        onClick={props.onRestore}
        title={translate('sessionGrid.restore', 'Bring back {{label}}', { label: props.label })}
        className="inline-flex min-w-0 items-center gap-1 outline-none focus-visible:underline"
      >
        <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden strokeWidth={1.75} />
        <span className="min-w-0 truncate">{props.label}</span>
      </button>
      <button
        type="button"
        onClick={props.onDiscard}
        aria-label={translate('sessionGrid.discard', 'Remove {{label}} from the grid', {
          label: props.label
        })}
        className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

export function SessionGridHeader(props: {
  layout: SessionGridLayout
  minimized: readonly SessionGridPane[]
  labelFor: (pane: SessionGridPane) => string
  sessions: readonly SidebarSession[]
  browserWorktreeId: string | null
  onApplyPreset: (preset: SessionGridPreset) => void
  onRestore: (paneId: string) => void
  onDiscard: (paneId: string) => void
  commandCenterControls?: React.ReactNode
  onShowWorkspace: () => void
}): React.JSX.Element {
  const count = props.layout.tracks.flat().length
  return (
    <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-3">
      <LayoutGrid className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      <h1 className="text-sm font-semibold">{translate('sessionGrid.title', 'Grid')}</h1>
      <span className="text-xs tabular-nums text-muted-foreground" data-session-grid-count={count}>
        {translate('sessionGrid.count', '{{count}} of {{max}}', {
          count,
          max: SESSION_GRID_MAX_PANES
        })}
      </span>
      {props.commandCenterControls}
      <SessionGridLayoutPicker layout={props.layout} onApply={props.onApplyPreset} />
      <SessionGridAddMenu sessions={props.sessions} browserWorktreeId={props.browserWorktreeId} />
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1"
        aria-label={translate('sessionGrid.minimized', 'Minimized panes')}
      >
        {props.minimized.map((pane) => (
          <TrayChip
            key={pane.id}
            pane={pane}
            label={props.labelFor(pane)}
            onRestore={() => props.onRestore(pane.id)}
            onDiscard={() => props.onDiscard(pane.id)}
          />
        ))}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 gap-1.5"
        onClick={props.onShowWorkspace}
      >
        <LayoutTemplate className="size-3.5" />
        {translate('auto.components.attention.AttentionPage.workspaceView', 'Workspace view')}
      </Button>
    </header>
  )
}
