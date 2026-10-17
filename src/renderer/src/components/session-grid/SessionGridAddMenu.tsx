import { useMemo, useState } from 'react'
import { Globe, NotebookPen, Plus, SquareTerminal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { newSessionGridNotepad, useSessionGrid } from '@/store/session-grid'
import { addContentsToSessionGrid } from '@/lib/session-grid-actions'
import { beginSessionGridDrag, clearSessionGridDrag } from '@/lib/session-grid-drag'
import {
  sameSessionGridContent,
  sessionGridContentForSession,
  type SessionGridPaneContent
} from '@/lib/session-grid-panes'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { BrowserTab as BrowserTabState } from '../../../../shared/browser-workspace-types'

const LIST_LIMIT = 40

type Item = {
  key: string
  icon: typeof Globe
  label: string
  detail: string
  content: SessionGridPaneContent
}

function browserLabel(tab: BrowserTabState): string {
  return tab.title || tab.url || translate('sessionGrid.browserTab', 'Browser tab')
}

/** Everything that can join the grid, minus what is already on it. */
function useAddableItems(
  sessions: readonly SidebarSession[],
  query: string
): {
  sessions: Item[]
  browsers: Item[]
} {
  const browserTabsByWorktree = useAppStore((state) => state.browserTabsByWorktree)
  const panes = useSessionGrid((state) => state.panes)
  const layout = useSessionGrid((state) => state.layout)
  return useMemo(() => {
    const shown = layout.tracks.flat().flatMap((id) => (panes[id] ? [panes[id]] : []))
    const needle = query.trim().toLowerCase()
    const matches = (item: Item): boolean =>
      !needle || `${item.label} ${item.detail}`.toLowerCase().includes(needle)
    const notShown = (item: Item): boolean =>
      !shown.some((pane) => sameSessionGridContent(pane, item.content))
    const sessionItems: Item[] = sessions
      .filter((session) => !session.unavailable)
      .map((session) => ({
        key: `session:${session.rowKey}`,
        icon: SquareTerminal,
        label: session.label,
        detail: session.workspaceLabel,
        content: sessionGridContentForSession(session)
      }))
    const browserItems: Item[] = Object.entries(browserTabsByWorktree).flatMap(
      ([worktreeId, tabs]) =>
        // Why: the floating workspace's tabs belong to its own panel, which can be open over the grid.
        worktreeId === FLOATING_TERMINAL_WORKTREE_ID
          ? []
          : tabs.map((tab) => ({
              key: `browser:${tab.id}`,
              icon: Globe,
              label: browserLabel(tab),
              detail: tab.url,
              content: {
                kind: 'browser' as const,
                worktreeId,
                browserTabId: tab.id,
                label: browserLabel(tab)
              }
            }))
    )
    return {
      sessions: sessionItems.filter(notShown).filter(matches).slice(0, LIST_LIMIT),
      browsers: browserItems.filter(notShown).filter(matches).slice(0, LIST_LIMIT)
    }
  }, [browserTabsByWorktree, layout, panes, query, sessions])
}

function ItemRow({
  item,
  onPick
}: {
  item: Item
  onPick: (item: Item) => void
}): React.JSX.Element {
  const Icon = item.icon
  return (
    <button
      type="button"
      draggable
      onDragStart={(event) =>
        beginSessionGridDrag(event.dataTransfer, { kind: 'content', content: item.content })
      }
      onDragEnd={clearSessionGridDrag}
      onClick={() => onPick(item)}
      title={translate('sessionGrid.addItemHint', 'Click to add, or drag onto a pane')}
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-accent"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      <span className="max-w-[40%] shrink-0 truncate text-[11px] text-muted-foreground">
        {item.detail}
      </span>
    </button>
  )
}

/** Adds a conversation, an open browser tab, a new browser tab or a notepad to the grid. */
export function SessionGridAddMenu(props: {
  sessions: readonly SidebarSession[]
  /** The workspace a new browser tab belongs to: the focused pane's, else the active one. */
  browserWorktreeId: string | null
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const items = useAddableItems(props.sessions, query)
  const add = (content: SessionGridPaneContent): void => {
    addContentsToSessionGrid([content], null)
    setOpen(false)
  }
  const newBrowserTab = (): void => {
    const worktreeId = props.browserWorktreeId
    const state = useAppStore.getState()
    if (!worktreeId) {
      toast.error(translate('sessionGrid.noWorkspace', 'Open a workspace first.'))
      return
    }
    try {
      const tab = state.createBrowserTab(worktreeId, state.browserDefaultUrl ?? 'about:blank', {
        activate: false
      })
      add({ kind: 'browser', worktreeId, browserTabId: tab.id, label: browserLabel(tab) })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5">
          <Plus className="size-3.5" />
          {translate('sessionGrid.add', 'Add')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-2">
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={translate('sessionGrid.findToAdd', 'Find a session or browser tab…')}
          aria-label={translate('sessionGrid.findToAdd', 'Find a session or browser tab…')}
          className="mb-2 h-8"
        />
        <div className="scrollbar-sleek max-h-80 space-y-2 overflow-y-auto">
          <section>
            <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {translate('sessionGrid.sessions', 'Sessions')}
            </h3>
            {items.sessions.length === 0 ? (
              <p className="px-2 text-xs text-muted-foreground">
                {translate('sessionGrid.noSessions', 'No other sessions.')}
              </p>
            ) : (
              items.sessions.map((item) => (
                <ItemRow key={item.key} item={item} onPick={(picked) => add(picked.content)} />
              ))
            )}
          </section>
          <section>
            <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {translate('sessionGrid.browserTabs', 'Browser tabs')}
            </h3>
            {items.browsers.length === 0 ? (
              <p className="px-2 text-xs text-muted-foreground">
                {translate('sessionGrid.noBrowserTabs', 'No other open browser tabs.')}
              </p>
            ) : (
              items.browsers.map((item) => (
                <ItemRow key={item.key} item={item} onPick={(picked) => add(picked.content)} />
              ))
            )}
          </section>
        </div>
        <div className="mt-2 flex gap-1.5 border-t border-border pt-2">
          <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={newBrowserTab}>
            <Globe className="size-3.5" />
            {translate('sessionGrid.newBrowserTab', 'New browser tab')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 gap-1.5"
            onClick={() => add(newSessionGridNotepad())}
          >
            <NotebookPen className="size-3.5" />
            {translate('sessionGrid.newNotepad', 'Notepad')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
