import { lazy, Suspense, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { useSessionGrid } from '@/store/session-grid'
import { paneContentEntry } from '@/lib/pane-content-registry'
import { sessionGridContentForSession } from '@/lib/session-grid-panes'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { selectGridDefaultSession } from '@/lib/session-grid-default-session'
import {
  selectOnScreenSessionTabId,
  selectOnScreenSessionLeafId
} from '@/lib/sidebar-session-on-screen'
import {
  selectAgentPaneSnapshot,
  selectAgentPaneSnapshotInputs
} from '../attention/use-agent-pane-snapshot'
import { translate } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'

const ReadyPane = lazy(() => import('./ReadyPane'))
const NeedsYou = lazy(() =>
  import('../work/WorkNeedsYouSection').then((module) => ({ default: module.WorkNeedsYouSection }))
)
const Decisions = lazy(() =>
  import('../command-center/OmniOSDecisionsPane').then((module) => ({
    default: module.OmniOSDecisionsPane
  }))
)
const Artifacts = lazy(() => import('../artifacts/ArtifactsPage'))
const Overview = lazy(() => import('../command-center/SessionOverviewPane'))
const PlainTerminal = lazy(() => import('../command-center/PlainTerminalPane'))
const Statistics = lazy(() => import('./SessionGridStatisticsBody'))

const Projects = lazy(() => import('../projects/SessionProjectsPage'))
const Companies = lazy(() => import('../companies/CompaniesPage'))
const Tasks = lazy(() => import('../TaskPage'))
const Kanban = lazy(() => import('../work/KanbanPage'))
const Dispatch = lazy(() =>
  import('../work/WorkDispatchComposer').then((module) => ({
    default: module.WorkDispatchComposer
  }))
)
const Happening = lazy(() =>
  import('../work/WorkHappeningSection').then((module) => ({
    default: module.WorkHappeningSection
  }))
)
const WorkProjects = lazy(() =>
  import('../work/WorkProjectsSection').then((module) => ({ default: module.WorkProjectsSection }))
)
const Stats = lazy(() =>
  import('../work/WorkStatsSection').then((module) => ({ default: module.WorkStatsSection }))
)
const WorkCompanies = lazy(() =>
  import('../work/WorkCompaniesSection').then((module) => ({
    default: module.WorkCompaniesSection
  }))
)
const WorkArtifacts = lazy(() =>
  import('../work/WorkArtifactsSection').then((module) => ({
    default: module.WorkArtifactsSection
  }))
)

export function SessionGridViewBody(props: {
  paneId: string
  viewId: string
  selectDefault?: boolean
  sessions: readonly SidebarSession[]
  visible: boolean
}): React.JSX.Element {
  const entry = paneContentEntry(props.viewId)
  if (props.viewId === 'overview') {
    return (
      <div className="h-full overflow-y-auto scrollbar-sleek p-3">
        <Suspense>
          <Overview paneId={props.paneId} sessions={props.sessions} />
        </Suspense>
      </div>
    )
  }
  if (props.viewId === 'terminal') {
    return (
      <Suspense>
        <PlainTerminal paneId={props.paneId} />
      </Suspense>
    )
  }
  if (props.viewId === 'session-chooser') {
    return (
      <SessionChooser
        paneId={props.paneId}
        sessions={props.sessions}
        selectDefault={props.selectDefault}
      />
    )
  }
  if (props.viewId === 'ready') {
    return (
      <Suspense
        fallback={<PaneNotice>{translate('commandCenter.loading', 'Loading…')}</PaneNotice>}
      >
        <ReadyPane paneId={props.paneId} />
      </Suspense>
    )
  }
  if (props.viewId === 'browser') {
    return <BrowserChooser paneId={props.paneId} />
  }
  if (!entry || entry.mount === 'placeholder') {
    return (
      <PaneNotice>{translate('commandCenter.comingLater', 'Coming in a later step.')}</PaneNotice>
    )
  }
  if (entry.mount === 'full-page') {
    return (
      <PaneNotice>
        <p>{translate('commandCenter.opensFullPage', 'This view opens full page.')}</p>
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            if (entry.fullPage) {
              useAppStore.getState().setActiveView(entry.fullPage)
            }
          }}
        >
          {translate('commandCenter.openFullPage', 'Open full page')}
        </Button>
      </PaneNotice>
    )
  }
  const bodies: Record<string, React.ReactNode> = {
    'section:needs-you': <NeedsYou />,
    'section:artifacts': <WorkArtifacts />,
    'omnios-decisions': <Decisions />,
    'session-statistics': <Statistics />,
    artifacts: <Artifacts embedded />,
    'page:project': <Projects />,
    'page:companies': <Companies />,
    'page:tasks': <Tasks embedded />,
    'page:kanban': <Kanban embedded visible={props.visible} />,
    'section:dispatch': <Dispatch />,
    'section:happening': <Happening />,
    'section:projects': <WorkProjects />,
    'section:stats': <Stats revision={0} />,
    'section:companies': <WorkCompanies revision={0} />
  }
  return (
    <div className="h-full overflow-y-auto scrollbar-sleek p-3" data-grid-view={props.viewId}>
      <Suspense
        fallback={<PaneNotice>{translate('commandCenter.loading', 'Loading…')}</PaneNotice>}
      >
        {bodies[props.viewId]}
      </Suspense>
    </div>
  )
}

export function PaneNotice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}

function SessionChooser(props: {
  paneId: string
  sessions: readonly SidebarSession[]
  selectDefault?: boolean
}): React.JSX.Element {
  useEffect(() => {
    if (!props.selectDefault) {
      return
    }
    const grid = useSessionGrid.getState()
    if (grid.layout.tracks.flat().some((id) => grid.panes[id]?.kind === 'session')) {
      return
    }
    const state = useAppStore.getState()
    const snapshot = selectAgentPaneSnapshot(selectAgentPaneSnapshotInputs(state))
    const current = { ...state, activeView: 'terminal' as const }
    const session = selectGridDefaultSession(
      props.sessions,
      snapshot.attention.map((pane) => ({
        ...pane,
        hostId: getResolvedExecutionHostIdForWorktree(state, pane.worktreeId)
      })),
      {
        hostId: getResolvedExecutionHostIdForWorktree(state, state.activeWorktreeId),
        worktreeId: state.activeWorktreeId,
        tabId: selectOnScreenSessionTabId(current),
        leafId: selectOnScreenSessionLeafId(current)
      }
    )
    if (session) {
      const focused = grid.focusedPaneId
      grid.replacePane(props.paneId, sessionGridContentForSession(session))
      if (focused !== props.paneId) {
        grid.focusPane(focused)
      }
    }
  }, [props.paneId, props.sessions, props.selectDefault])
  const [query, setQuery] = useState('')
  const rows = props.sessions
    .filter((session) => session.label.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 40)
  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={translate('commandCenter.searchSessions', 'Search sessions…')}
      />
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        {rows.length ? (
          rows.map((session) => (
            <button
              key={session.rowKey}
              type="button"
              onClick={() =>
                useSessionGrid
                  .getState()
                  .replacePane(props.paneId, sessionGridContentForSession(session))
              }
              className="flex w-full flex-col rounded-sm p-2 text-left text-xs hover:bg-accent focus-visible:bg-accent"
            >
              <span>{session.label}</span>
              <span className="text-muted-foreground">{session.workspaceLabel}</span>
            </button>
          ))
        ) : (
          <PaneNotice>
            {translate('commandCenter.noSessions', 'Sessions will appear here when available.')}
          </PaneNotice>
        )}
      </div>
    </div>
  )
}

function BrowserChooser({ paneId }: { paneId: string }): React.JSX.Element {
  const tabs = useAppStore((state) => state.browserTabsByWorktree)
  const worktreeId = useAppStore((state) => state.activeWorktreeId)
  const [url, setUrl] = useState('')
  const choose = (worktree: string, id: string, label: string): void =>
    useSessionGrid
      .getState()
      .replacePane(paneId, { kind: 'browser', worktreeId: worktree, browserTabId: id, label })
  const open = (): void => {
    if (!worktreeId || !url.trim()) {
      return
    }
    try {
      const parsed = new URL(url.trim())
      if (!['https:', 'http:'].includes(parsed.protocol)) {
        throw new Error(translate('commandCenter.invalidBrowserUrl', 'Use an HTTP or HTTPS URL'))
      }
      const tab = useAppStore.getState().createBrowserTab(worktreeId, parsed.href)
      choose(worktreeId, tab.id, tab.title || tab.url)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          open()
        }}
        className="flex gap-2"
      >
        <Input
          aria-label={translate('commandCenter.browserUrl', 'Browser URL')}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={translate('commandCenter.browserUrlExample', 'https://')}
        />
        <Button size="sm" disabled={!worktreeId || !url.trim()}>
          {translate('commandCenter.open', 'Open')}
        </Button>
      </form>
      {!worktreeId ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'commandCenter.browserWorkspace',
            'Select a workspace to open a new browser page.'
          )}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        {Object.entries(tabs).flatMap(([worktree, entries]) =>
          entries.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className="block w-full truncate rounded-sm p-2 text-left text-xs hover:bg-accent focus-visible:bg-accent"
              onClick={() => choose(worktree, tab.id, tab.title || tab.url)}
            >
              {tab.title || tab.url}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
