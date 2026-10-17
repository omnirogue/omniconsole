import { useAppStore } from '@/store'
import { sessionRowHostName } from '@/lib/session-row-host'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import ArtifactsPage from '../artifacts/ArtifactsPage'
import { WorkReviewWaitsSection } from '../work/WorkReviewWaitsSection'
import { SessionStatisticsView } from './SessionStatisticsView'
import { useSessionStatisticsSnapshot } from './use-session-statistics-snapshot'

export { OmniOSDecisionsPane, OMNIOS_DECISIONS_VIEW_ID } from './OmniOSDecisionsPane'
export { SESSION_STATISTICS_VIEW_ID } from './SessionStatisticsView'
export const ARTIFACTS_VIEW_ID = 'artifacts'
export const REVIEW_WAITS_VIEW_ID = 'review-waits'

export function ArtifactsPaneBody(): React.JSX.Element | null {
  const enabled = useAppStore((state) => state.settings?.commandCenter === true)
  return enabled ? <ArtifactsPage embedded /> : null
}

export function ReviewWaitsPaneBody(): React.JSX.Element | null {
  const enabled = useAppStore((state) => state.settings?.commandCenter === true)
  return enabled ? <WorkReviewWaitsSection embedded /> : null
}

export function SessionStatisticsPaneBody(): React.JSX.Element | null {
  const enabled = useAppStore((state) => state.settings?.commandCenter === true)
  return enabled ? <LiveSessionStatistics /> : null
}

function LiveSessionStatistics(): React.JSX.Element {
  const snapshot = useSessionStatisticsSnapshot()
  const sshLabels = useAppStore((state) => state.sshTargetLabels)
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const labels = new Map<string, string>()
  for (const hostId of snapshot.data.byHost.keys()) {
    labels.set(
      hostId,
      sessionRowHostName(normalizeExecutionHostId(hostId), sshLabels, environments)
    )
  }
  return <SessionStatisticsView snapshot={snapshot} hostLabels={labels} embedded />
}
