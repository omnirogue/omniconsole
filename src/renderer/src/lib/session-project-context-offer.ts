import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  projectLaunchPrompt,
  resolveProjectLaunch
} from '../../../shared/project-launch-inheritance'
import { launchProjectFor, projectLaunchHost } from './project-launch'
import {
  buildPaneSessions,
  type SidebarSession,
  type SidebarSessionSource
} from './sidebar-sessions'
import { canReplyToSession, sendSessionReply } from './session-reply-send'

/** What a session filed into a project is sent: the project's line, roster and context for its host. */
export function projectContextMessage(folderId: string, worktreeId: string | null): string | null {
  const project = launchProjectFor(folderId)
  if (!project) {
    return null
  }
  const host = projectLaunchHost(worktreeId)
  const resolution = resolveProjectLaunch({
    project,
    launch: [],
    session: [],
    removed: [],
    host,
    templateId: null
  })
  // Why no agent: a running session already has its role; only the project's context is new.
  return projectLaunchPrompt(
    { ...resolution, project: { folderId: project.folderId, name: project.name } },
    {
      prompt: translate(
        'projects.contextOffer.lead',
        'You were moved into the project “{{name}}”. Its context follows; use it from now on.',
        { name: project.name }
      ),
      hostLabel: host.label,
      agent: false
    }
  )
}

function liveSessionsFor(keys: readonly string[]): SidebarSession[] {
  const wanted = new Set(keys)
  return buildPaneSessions(useAppStore.getState() as unknown as SidebarSessionSource).filter(
    (session) => wanted.has(session.sessionKey ?? session.rowKey) && canReplyToSession(session)
  )
}

/** Sends the project's context into each reachable session; resolves to how many received it. */
export async function sendProjectContext(
  keys: readonly string[],
  folderId: string
): Promise<{ sent: number; failed: string[] }> {
  let sent = 0
  const failed: string[] = []
  for (const session of liveSessionsFor(keys)) {
    const message = projectContextMessage(folderId, session.worktreeId)
    if (!message) {
      break
    }
    try {
      await sendSessionReply(session, message)
      sent++
    } catch (error) {
      failed.push(`${session.label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { sent, failed }
}

/**
 * After the person files sessions into a project, offers to give them its context. Never
 * automatic: a session that only moved keeps what it already had.
 */
export function offerProjectContext(keys: readonly string[], folderId: string | null): void {
  const project = folderId ? launchProjectFor(folderId) : null
  if (!project || liveSessionsFor(keys).length === 0) {
    return
  }
  toast(translate('projects.contextOffer.title', 'Filed in {{name}}.', { name: project.name }), {
    action: {
      label: translate('projects.contextOffer.action', 'Give it the project’s context'),
      onClick: () => {
        void sendProjectContext(keys, project.folderId).then(({ sent, failed }) => {
          if (failed.length) {
            toast.error(failed.join('\n'))
          } else if (sent) {
            toast.success(
              translate('projects.contextOffer.sent', 'Sent {{name}}’s context.', {
                name: project.name
              })
            )
          }
        })
      }
    }
  })
}
