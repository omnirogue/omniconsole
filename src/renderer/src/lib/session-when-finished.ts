import { useSessionFolders } from '@/store/session-folders'
import { useWaitLater } from '@/store/wait-later-store'
import { readUpNext } from '@/components/next-action/up-next-client'
import { upNextConnection } from '@/components/next-action/up-next-connection'
import type { SessionFinishChoice } from '../../../shared/session-finish-intent'
import { conversationViewKey } from './conversation-view'
import { conversationSourceForSession } from './conversation-source-for-session'
import { closeSessionTab, sessionTabHasUnfinishedAgent } from './close-session-tab'
import { outcomeRuntimeTarget } from './session-outcome-owner'
import { waitLaterKeyForPane } from './wait-later'
import type { SessionFinishAction } from './session-folders'
import type { SidebarSession } from './sidebar-sessions'

const applying = new Set<string>()

export function readWhenFinished(session: SidebarSession): SessionFinishChoice | undefined {
  const action = useSessionFolders.getState().metadata.finishActions?.[conversationViewKey(session)]
  return action?.afterCompletion
    ? {
        action: action.action,
        ...(action.folderId ? { folderId: action.folderId } : {})
      }
    : undefined
}

/** A device preference, like its Saved folder; selecting it never completes work or a task. */
export function scheduleWhenFinished(
  session: SidebarSession,
  choice: SessionFinishChoice | null
): void {
  const folders = useSessionFolders.getState()
  if (!folders.loaded) {
    folders.load()
  }
  const current = useSessionFolders.getState()
  const key = conversationViewKey(session)
  const saved =
    choice && choice.action !== 'me'
      ? current.setFinishAction(key, {
          action: choice.action,
          folderId: choice.folderId ?? null,
          afterCompletion: true,
          applied: false
        })
      : current.clearFinishAction(key)
  if (!saved) {
    throw new Error(current.error ?? 'Could not save the When finished setting.')
  }
}

/** The execution host confirms completion; a window only files or closes its own tab. */
export async function applyWhenFinished(
  session: SidebarSession,
  expected: SessionFinishAction,
  save: (session: SidebarSession, folderId: string | null) => boolean | Promise<boolean>
): Promise<void> {
  const key = conversationViewKey(session)
  if (
    !expected.afterCompletion ||
    expected.applied ||
    applying.has(key) ||
    !session.tabId ||
    session.unavailable ||
    sessionTabHasUnfinishedAgent(session.tabId)
  ) {
    return
  }
  applying.add(key)
  try {
    const source = conversationSourceForSession(session, session.hostId ?? 'local')
    if (!source) {
      return
    }
    const connection = upNextConnection(outcomeRuntimeTarget(session))
    const view = await readUpNext(source, connection)
    connection.assertCurrent()
    // An older/disconnected host, a changed preference, or new activity cannot finish a session.
    if (
      view.finishReady !== true ||
      useSessionFolders.getState().metadata.finishActions?.[key] !== expected ||
      sessionTabHasUnfinishedAgent(session.tabId)
    ) {
      return
    }
    const applied =
      expected.action === 'save'
        ? await save(session, expected.folderId)
        : expected.action === 'end' &&
          (await closeSessionTab(session.tabId, { rejectPinned: true })) === true
    if (applied) {
      useSessionFolders.getState().setFinishAction(key, {
        ...expected,
        applied: true,
        completedAt: Date.now()
      })
      if (session.paneKey) {
        useWaitLater.getState().setFinished(waitLaterKeyForPane(session.paneKey), new Date())
      }
    }
  } catch (error) {
    console.warn('[session-finish] waiting for verified completion', error)
  } finally {
    applying.delete(key)
  }
}
