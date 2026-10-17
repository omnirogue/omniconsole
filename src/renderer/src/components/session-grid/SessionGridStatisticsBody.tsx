import { SessionStatisticsView } from '../command-center/SessionStatisticsView'
import { useSessionStatisticsSnapshot } from '../command-center/use-session-statistics-snapshot'

export default function SessionGridStatisticsBody(): React.JSX.Element {
  const snapshot = useSessionStatisticsSnapshot()
  return <SessionStatisticsView snapshot={snapshot} embedded />
}
