import { sendInboxStructuredInstruction } from '@/components/inbox/inbox-structured-instruction'
import { translate } from '@/i18n/i18n'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import {
  activeAgentNotesSendFailureMessage,
  sendNotesToActiveAgentSession
} from './active-agent-note-send'
import type { SidebarSession } from './sidebar-sessions'

/** Whether a message can be sent into this session without opening it. */
export function canReplyToSession(session: SidebarSession): boolean {
  if (session.unavailable) {
    return false
  }
  return session.kind === 'structured'
    ? Boolean(session.structuredSessionId)
    : Boolean(session.tabId && session.paneKey)
}

/**
 * Sends the person's message into a session from outside its pane, by the same guarded paths as
 * Inbox's "Send to my AI": the agent must hold the terminal, so nothing is typed into a shell.
 * Throws with a readable reason when nothing (or not everything) was sent.
 */
export async function sendSessionReply(session: SidebarSession, text: string): Promise<void> {
  if (session.kind === 'structured') {
    await sendInboxStructuredInstruction(session, text)
    return
  }
  const pane = session.paneKey ? parsePaneKey(session.paneKey) : null
  const host = parseExecutionHostId(session.hostId)
  if (session.unavailable || !host || !session.tabId || !pane || pane.tabId !== session.tabId) {
    throw new Error(
      translate('projects.reply.unavailable', 'This thread’s terminal is no longer available.')
    )
  }
  const result = await sendNotesToActiveAgentSession({
    worktreeId: session.worktreeId,
    prompt: text,
    // A mirrored row names its owner independently of the currently selected workspace.
    ...(host.kind === 'runtime'
      ? { runtimeTarget: { kind: 'environment' as const, environmentId: host.environmentId } }
      : {}),
    noteTarget: {
      tabId: host.kind === 'runtime' ? toHostSessionTabId(session.tabId) : session.tabId,
      leafId: pane.leafId
    }
  })
  if (result.status !== 'sent') {
    throw new Error(
      activeAgentNotesSendFailureMessage(result.status, {
        explicitTarget: true
      })
    )
  }
}
