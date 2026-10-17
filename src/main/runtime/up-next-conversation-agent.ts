/**
 * Which agent a conversation is talking to, when that conversation has no terminal.
 *
 * A PTY conversation carries its agent on the pane record. A STRUCTURED one — Native Chat,
 * the ordinary chat session a person composes Up next on — has no PTY at all, and its agent
 * is known only to the structured session host. Without this, every Agent block committed on
 * a chat session was refused (`needsAgent`) and every move or remove recommit silently
 * downgraded the plan's actor to `claude`.
 *
 * The match is the one the runtime already uses to resolve a structured source pane
 * (`resolveSessionOutcomePlanningCoordinator`): a session's pane key is derived from its own
 * id, so the pane names the session. Two sessions claiming one pane is not a reading — the
 * host answers null rather than guess which agent the work would run on.
 */

import type { StructuredAgentSessionTab } from '../native-chat/agent-session-wire/structured-agent-session-host-tabs'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { TuiAgent } from '../../shared/tui-agent'

export function structuredConversationAgent(
  paneKey: string,
  tabs: readonly StructuredAgentSessionTab[]
): TuiAgent | null {
  const matches = tabs.filter(
    (tab) =>
      structuredAgentSessionPaneKey(structuredAgentSessionTabId(tab.sessionId), tab.sessionId) ===
      paneKey
  )
  return matches.length === 1 ? matches[0]!.agent : null
}
