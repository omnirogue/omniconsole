import { sessionActivities } from '@/components/work/work-model'
import { sidebarSessionStatusKey } from './sidebar-session-source-identity'

/** Structured rows publish under their source key, while placement keeps the original identity. */
export function sessionOverviewActivities(
  ...args: Parameters<typeof sessionActivities>
): ReturnType<typeof sessionActivities> {
  const [sessions, snapshot, waiting, until, finished] = args
  const originals = new Map(sessions.map((session) => [session.rowKey, session]))
  const projected = sessions.map((session) => ({
    ...session,
    paneKey: sidebarSessionStatusKey(session)
  }))
  return sessionActivities(projected, snapshot, waiting, until, finished).map((row) => ({
    ...row,
    session: originals.get(row.session.rowKey)!
  }))
}
