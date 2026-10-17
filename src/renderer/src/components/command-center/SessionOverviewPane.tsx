import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { sessionGridPaneIds } from '@/lib/session-grid-layout'
import { useSessionGrid } from '@/store/session-grid'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAgentPaneSnapshot } from '../attention/use-agent-pane-snapshot'
import { useFinishedMarks, useWaitingKeys, useWaitingUntil } from '@/store/wait-later-store'
import { sessionOverviewActivities } from '@/lib/session-overview-activities'
import { selectSessionOverviewCounts } from '@/lib/session-overview-counts'
import { sessionGridContentForSession } from '@/lib/session-grid-panes'
import { addContentsToSessionGrid } from '@/lib/session-grid-actions'
import { beginCommandCenterSessionDrag } from '@/lib/command-center-session-drag'
import { clearSessionSidebarDrag } from '@/lib/session-sidebar-drag'
import { sidebarSessionStatusKey } from '@/lib/sidebar-session-source-identity'
import { useSessionActivity } from '../session-activity/use-session-activity'
import { activityAgeLabel } from '../session-activity/session-activity-text'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

const LABELS = {
  'needs-you': 'Needs you',
  working: 'Working',
  waiting: 'Waiting',
  doneToday: 'Done today',
  idle: 'Idle',
  finished: 'Done'
}

export default function SessionOverviewPane(props: {
  paneId: string
  sessions: readonly SidebarSession[]
}): React.JSX.Element | null {
  const enabled = useAppStore((state) => state.settings?.commandCenter === true)
  return enabled ? <Overview {...props} /> : null
}

function Overview({
  paneId,
  sessions
}: {
  paneId: string
  sessions: readonly SidebarSession[]
}): React.JSX.Element {
  const snapshot = useAgentPaneSnapshot()
  const waiting = useWaitingKeys()
  const until = useWaitingUntil()
  const finished = useFinishedMarks()
  const epoch = useAppStore((state) => state.agentStatusEpoch)
  const rows = useMemo(
    () => sessionOverviewActivities(sessions, snapshot, waiting, until, finished),
    [sessions, snapshot, waiting, until, finished]
  )
  const { counts, now } = useMemo(() => {
    void epoch
    return selectSessionOverviewCounts(rows, finished)
  }, [epoch, rows, finished])
  const panes = useSessionGrid((state) => state.panes)
  const layout = useSessionGrid((state) => state.layout)
  const [placement, setPlacement] = useState('new')
  const open = (session: SidebarSession): void => {
    const grid = useSessionGrid.getState()
    const shown = sessionGridPaneIds(grid.layout)
    const target =
      placement === 'focused'
        ? grid.recentPaneIds.find((id) => id !== paneId && shown.includes(id))
        : placement
    const content = sessionGridContentForSession(session)
    if (placement !== 'new' && target && target !== paneId && grid.panes[target]) {
      grid.replacePane(target, content)
    } else {
      addContentsToSessionGrid([content], { paneId, zone: 'right' })
    }
  }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-5 gap-2">
        {Object.entries(counts).map(([key, count]) => (
          <div key={key} className="rounded-md border p-2 text-center">
            <div className="text-sm font-medium">{count}</div>
            <div className="text-xs text-muted-foreground">
              {translate(`commandCenter.overview.${key}`, LABELS[key as keyof typeof LABELS])}
            </div>
          </div>
        ))}
      </div>
      <label className="flex items-center gap-2 text-xs">
        {translate('commandCenter.overview.openIn', 'Open in')}
        <select
          aria-label={translate('commandCenter.overview.placement', 'Session placement')}
          className="rounded-md border bg-background p-1"
          value={placement}
          onChange={(event) => setPlacement(event.target.value)}
        >
          <option value="new">{translate('commandCenter.overview.newPane', 'New pane')}</option>
          <option value="focused">
            {translate('commandCenter.overview.focusedPane', 'Last focused pane')}
          </option>
          {Object.values(panes)
            .filter((pane) => pane.id !== paneId && sessionGridPaneIds(layout).includes(pane.id))
            .map((pane) => (
              <option key={pane.id} value={pane.id}>
                {pane.kind === 'session' || pane.kind === 'browser'
                  ? pane.label
                  : pane.kind === 'view'
                    ? pane.viewId
                    : pane.kind}
              </option>
            ))}
        </select>
      </label>
      <ul className="space-y-2">
        {rows.map((row) => (
          <OverviewRow key={row.session.rowKey} row={row} now={now} onOpen={open} />
        ))}
      </ul>
      {!rows.length ? (
        <p className="text-xs text-muted-foreground">
          {translate('commandCenter.overview.empty', 'No sessions to show.')}
        </p>
      ) : null}
    </div>
  )
}

function OverviewRow({
  row,
  now,
  onOpen
}: {
  row: ReturnType<typeof sessionOverviewActivities>[number]
  now: number
  onOpen: (session: SidebarSession) => void
}): React.JSX.Element {
  const hostLabel = useAppStore((state) =>
    row.session.hostId ? selectExecutionHostDisplayLabel(state, row.session.hostId) : 'Unverifiable'
  )
  const activity = useSessionActivity({ paneKey: sidebarSessionStatusKey(row.session) })
  return (
    <li
      draggable
      onDragStart={(event) => beginCommandCenterSessionDrag(event.dataTransfer, row.session)}
      onDragEnd={clearSessionSidebarDrag}
      className="flex items-center gap-2 rounded-md border p-2"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{row.session.label}</div>
        <div className="truncate text-xs text-muted-foreground">
          {translate(`commandCenter.overview.${row.state}`, LABELS[row.state])} · {activity.line} ·{' '}
          {hostLabel}
          {activity.state?.at ? ` · ${activityAgeLabel(activity.state.at, now)}` : ''}
        </div>
      </div>
      <Button size="xs" variant="outline" onClick={() => onOpen(row.session)}>
        {translate('work.open', 'Open')}
      </Button>
    </li>
  )
}
