import { ReadyPaneLaunchObserver } from './ReadyPane'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { SESSION_GRID_MAX_PANES } from '@/lib/session-grid-layout'
import { OpenInPaneContext } from '../open-in-pane-context'
import { normalizeExternalBrowserUrl } from '../../../../shared/browser-url'
import { toast } from 'sonner'
import { LayoutGrid } from 'lucide-react'
import { useHandoffScope } from '../handoffs/handoff-scope'
import { useAppStore } from '@/store'
import { newSessionGridNotepad, useSessionGrid } from '@/store/session-grid'
import { translate } from '@/i18n/i18n'
import { openSidebarSession } from '@/lib/open-sidebar-session'
import { resumeSessionInGrid, toastGridFull } from '@/lib/session-grid-actions'
import { resolveSessionGridSession, type SessionGridPane } from '@/lib/session-grid-panes'
import { activateBrowserPagePaletteResult } from '@/lib/browser-page-palette-activation'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSidebarSessions } from '../sidebar/session-folders/use-sidebar-sessions'
import type { BrowserTab as BrowserTabState } from '../../../../shared/browser-workspace-types'
import { paneContentEntry, paneContentLabel } from '@/lib/pane-content-registry'
import { SessionGridNamedLayouts, SessionGridStorageNotice } from './SessionGridNamedLayouts'
import { SessionGridViewBody, PaneNotice } from './SessionGridViewBody'
import { SessionGridCanvas } from './SessionGridCanvas'
import { SessionGridHeader } from './SessionGridHeader'
import { SessionGridPaneFrame } from './SessionGridPaneFrame'
import {
  SessionGridBrowserBody,
  SessionGridNotepadBody,
  SessionGridSessionBody
} from './SessionGridPaneBodies'
import {
  canShowSessionTerminal,
  useSessionGridTerminalPortals,
  type SessionGridTerminalSlot
} from './use-session-grid-portals'

type Resolved = {
  pane: SessionGridPane
  session: SidebarSession | null
  browserTab: BrowserTabState | null
}

function findBrowserTab(
  byWorktree: Record<string, BrowserTabState[]>,
  worktreeId: string,
  browserTabId: string
): BrowserTabState | null {
  return byWorktree[worktreeId]?.find((tab) => tab.id === browserTabId) ?? null
}

function noteTitle(text: string | undefined): string {
  const first = (text ?? '').split('\n').find((line) => line.trim())
  return first?.trim().slice(0, 60) || translate('sessionGrid.notepad', 'Notepad')
}

function openBrowserTabInWorkspace(worktreeId: string, browserTab: BrowserTabState): void {
  activateBrowserPagePaletteResult({
    worktreeId,
    workspaceId: browserTab.id,
    pageId: browserTab.activePageId ?? browserTab.pageIds?.[0] ?? browserTab.id
  })
}

/**
 * Up to eight panes on one screen — conversations from any workspace, browser tabs and
 * notepads — arranged in columns or rows and resized by hand. Terminals are the live ones
 * borrowed from the hidden workbench, never copies.
 */
export default function SessionGridPage(): React.JSX.Element {
  const grid = useSessionGrid()
  const commandCenter = useAppStore((state) => state.settings?.commandCenter === true)
  const accountScope = useHandoffScope()
  const { load } = grid
  useEffect(() => {
    load(commandCenter)
  }, [load, commandCenter, accountScope])
  const { flushWrites } = grid
  useEffect(() => {
    if (!commandCenter) {
      return
    }
    window.addEventListener('pagehide', flushWrites)
    window.addEventListener('beforeunload', flushWrites)
    return () => {
      flushWrites()
      window.removeEventListener('pagehide', flushWrites)
      window.removeEventListener('beforeunload', flushWrites)
    }
  }, [commandCenter, flushWrites])
  const sessions = useSidebarSessions()
  const browserTabsByWorktree = useAppStore((state) => state.browserTabsByWorktree)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const setActiveView = useAppStore((state) => state.setActiveView)
  const [targets, setTargets] = useState<ReadonlyMap<string, HTMLElement>>(new Map())

  const resolve = useCallback(
    (pane: SessionGridPane): Resolved => ({
      pane,
      session: pane.kind === 'session' ? resolveSessionGridSession(pane, sessions) : null,
      browserTab:
        pane.kind === 'browser'
          ? findBrowserTab(browserTabsByWorktree, pane.worktreeId, pane.browserTabId)
          : null
    }),
    [browserTabsByWorktree, sessions]
  )
  const shown = useMemo(
    () =>
      grid.layout.tracks.flat().flatMap((id) => (grid.panes[id] ? [resolve(grid.panes[id])] : [])),
    [grid.layout, grid.panes, resolve]
  )
  const slots = useMemo<SessionGridTerminalSlot[]>(
    () =>
      shown.flatMap(({ pane, session }) => {
        const target = targets.get(pane.id)
        return target && session && canShowSessionTerminal(session)
          ? [{ paneId: pane.id, session, target }]
          : []
      }),
    [shown, targets]
  )
  const maximizedPaneId = commandCenter ? grid.maximizedPaneId : null
  useSessionGridTerminalPortals(
    slots,
    grid.focusedPaneId,
    activeWorktreeId,
    'grid',
    maximizedPaneId
  )

  const setTarget = useCallback((paneId: string, element: HTMLElement | null) => {
    setTargets((current) => {
      if ((current.get(paneId) ?? null) === element) {
        return current
      }
      const next = new Map(current)
      if (element) {
        next.set(paneId, element)
      } else {
        next.delete(paneId)
      }
      return next
    })
  }, [])

  const labelFor = useCallback(
    (pane: SessionGridPane): string => {
      const { session, browserTab } = resolve(pane)
      if (pane.kind === 'session') {
        return session?.label ?? pane.label
      }
      if (pane.kind === 'browser') {
        return browserTab?.title || browserTab?.url || pane.label
      }
      if (pane.kind === 'view') {
        const entry = paneContentEntry(pane.viewId)
        return entry ? paneContentLabel(entry) : pane.viewId
      }
      if (pane.kind === 'unavailable') {
        return translate('commandCenter.unavailablePane', 'Unavailable in this version')
      }
      return noteTitle(grid.notes[pane.noteId]?.text)
    },
    [grid.notes, resolve]
  )

  const focused = shown.find(({ pane }) => pane.id === grid.focusedPaneId)
  const browserWorktreeId =
    (focused?.pane.kind === 'session' || focused?.pane.kind === 'browser'
      ? focused.pane.worktreeId
      : null) ?? activeWorktreeId

  const openInPane = useCallback((url: string): void => {
    const normalized = normalizeExternalBrowserUrl(url)
    const state = useAppStore.getState()
    if (!normalized || !state.activeWorktreeId) {
      toast.error(
        translate(
          'commandCenter.browserWorkspace',
          'Select a workspace to open a new browser page.'
        )
      )
      return
    }
    const current = useSessionGrid.getState()
    if (current.layout.tracks.flat().length >= SESSION_GRID_MAX_PANES) {
      toastGridFull(1)
      return
    }
    const tab = state.createBrowserTab(state.activeWorktreeId, normalized)
    current.addPane({
      kind: 'browser',
      worktreeId: state.activeWorktreeId,
      browserTabId: tab.id,
      label: tab.title || tab.url
    })
  }, [])

  const chooseContent = (id: string, paneId?: string): void => {
    const entry = paneContentEntry(id)
    if (entry?.mount === 'full-page' && entry.fullPage) {
      setActiveView(entry.fullPage)
      return
    }
    const content =
      id === 'notepad' ? newSessionGridNotepad() : { kind: 'view' as const, viewId: id }
    const existing =
      entry && !entry.multiple
        ? grid.layout.tracks.flat().find((shownId) => {
            const pane = grid.panes[shownId]
            return pane?.kind === 'view' && pane.viewId === id
          })
        : null
    if (existing) {
      grid.focusPane(existing)
      return
    }
    if (paneId) {
      grid.replacePane(paneId, content)
    } else {
      if (grid.addPane(content).status === 'full') {
        toastGridFull(1)
      }
    }
  }
  const renderPane = (paneId: string): React.ReactNode => {
    const entry = shown.find(({ pane }) => pane.id === paneId)
    if (!entry) {
      return null
    }
    const { pane, session, browserTab } = entry
    const isFocused = pane.id === grid.focusedPaneId
    const remove = (): void => grid.removePane(pane.id)
    return (
      <SessionGridPaneFrame
        pane={pane}
        label={labelFor(pane)}
        detail={
          pane.kind === 'session'
            ? (session?.workspaceLabel ?? null)
            : pane.kind === 'browser'
              ? (browserTab?.url ?? null)
              : null
        }
        focused={isFocused}
        onFocus={() => grid.focusPane(pane.id)}
        onOpen={
          pane.kind === 'session' && session
            ? () => openSidebarSession(session)
            : pane.kind === 'browser' && browserTab
              ? () => openBrowserTabInWorkspace(pane.worktreeId, browserTab)
              : undefined
        }
        onMinimize={() => grid.minimizePane(pane.id)}
        onChooseContent={commandCenter ? (id) => chooseContent(id, pane.id) : undefined}
        onToggleMaximize={
          commandCenter
            ? () => grid.maximizePane(maximizedPaneId === pane.id ? null : pane.id)
            : undefined
        }
        maximized={maximizedPaneId === pane.id}
        paneFocus={
          commandCenter
            ? { focused: isFocused, visible: !maximizedPaneId || maximizedPaneId === pane.id }
            : undefined
        }
        onClose={remove}
      >
        {pane.kind === 'session' ? (
          <SessionPaneTarget
            paneId={pane.id}
            session={session}
            setTarget={setTarget}
            onRemove={remove}
          />
        ) : pane.kind === 'browser' ? (
          <SessionGridBrowserBody
            browserTab={browserTab}
            focused={isFocused}
            visible={!maximizedPaneId || maximizedPaneId === pane.id}
            onRemove={remove}
          />
        ) : pane.kind === 'view' ? (
          <SessionGridViewBody
            paneId={pane.id}
            viewId={pane.viewId}
            selectDefault={pane.selectDefault}
            sessions={sessions}
            visible={!maximizedPaneId || maximizedPaneId === pane.id}
          />
        ) : pane.kind === 'unavailable' ? (
          <PaneNotice>
            {translate('commandCenter.unavailablePane', 'Unavailable in this version')}
          </PaneNotice>
        ) : (
          <NotepadPane noteId={pane.noteId} />
        )}
      </SessionGridPaneFrame>
    )
  }

  const minimized = grid.minimized.flatMap((id) => (grid.panes[id] ? [grid.panes[id]] : []))
  return (
    <OpenInPaneContext.Provider value={commandCenter ? openInPane : null}>
      <div data-session-grid-page="" className="flex h-full min-h-0 flex-col bg-background">
        {commandCenter ? (
          <>
            <SessionGridStorageNotice />
            <ReadyPaneLaunchObserver />
          </>
        ) : null}
        <SessionGridHeader
          layout={grid.layout}
          minimized={minimized}
          labelFor={labelFor}
          sessions={sessions}
          browserWorktreeId={browserWorktreeId}
          commandCenterControls={
            commandCenter ? (
              <SessionGridNamedLayouts onAdd={(id) => chooseContent(id)} />
            ) : undefined
          }
          onApplyPreset={grid.applyPreset}
          onRestore={(paneId) => grid.restorePane(paneId)}
          onDiscard={grid.removePane}
          onShowWorkspace={() => setActiveView('terminal')}
        />
        <SessionGridCanvas
          layout={grid.layout}
          maximizedPaneId={commandCenter ? maximizedPaneId : undefined}
          renderPane={renderPane}
          onResize={(next) =>
            grid.setLayoutSizes({ trackSizes: next.trackSizes, paneSizes: next.paneSizes })
          }
          empty={
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
              <LayoutGrid className="size-6" strokeWidth={1.5} />
              <p className="max-w-sm">
                {translate(
                  'sessionGrid.empty',
                  'Drag sessions from the sidebar here — up to eight — or use Add for browser tabs and notepads.'
                )}
              </p>
            </div>
          }
        />
      </div>
    </OpenInPaneContext.Provider>
  )
}

/** Binds one pane's terminal target with a stable ref, so a render never re-registers it. */
function SessionPaneTarget(props: {
  paneId: string
  session: SidebarSession | null
  setTarget: (paneId: string, element: HTMLElement | null) => void
  onRemove: () => void
}): React.JSX.Element {
  const { paneId, setTarget } = props
  const onTarget = useCallback(
    (element: HTMLElement | null) => setTarget(paneId, element),
    [paneId, setTarget]
  )
  return (
    <SessionGridSessionBody
      session={props.session}
      onTarget={onTarget}
      onResume={resumeSessionInGrid}
      onOpen={openSidebarSession}
      onRemove={props.onRemove}
    />
  )
}

function NotepadPane({ noteId }: { noteId: string }): React.JSX.Element {
  const text = useSessionGrid((state) => state.notes[noteId]?.text ?? '')
  const setNote = useSessionGrid((state) => state.setNote)
  const onChange = useCallback((next: string) => setNote(noteId, { text: next }), [noteId, setNote])
  return <SessionGridNotepadBody text={text} onChange={onChange} />
}
