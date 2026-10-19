/**
 * Why (Sal, 2026-10-19): agent sessions list apart from the person's own, in Agent sessions, and
 * only they are cleaned up unasked. The window keeps the note (session folder metadata), so it is
 * asked for each session an agent launches; a window still adding the new row is asked again.
 */

import type { SessionFolderRelayRequest } from '../../shared/session-folder-cli'

const MARK_ATTEMPTS = 6
const MARK_RETRY_MS = 5_000

type AgentSessionMarkRuntime = {
  requestSessionFolders(request: SessionFolderRelayRequest): Promise<unknown>
}

export function noteAgentSession(
  runtime: AgentSessionMarkRuntime,
  paneKey: string,
  attempts = MARK_ATTEMPTS
): void {
  let tries = 0
  const retry = (): void => {
    // An older window rejects the kind; the session then lists as before.
    if (tries < attempts) {
      setTimeout(attempt, MARK_RETRY_MS).unref?.()
    }
  }
  const attempt = (): void => {
    tries += 1
    // Why guarded: a note never fails the launch that asked for it.
    try {
      runtime.requestSessionFolders({ kind: 'markAgentSession', paneKey }).catch(retry)
    } catch {
      retry()
    }
  }
  attempt()
}

/**
 * A session prep launch is an agent's only through the OmniOS/MCP connector; a person's own
 * "create sessions for…" prep is theirs and stays with their sessions.
 */
export function noteConnectorLaunch<T extends { paneKey?: string | null }>(
  runtime: AgentSessionMarkRuntime,
  connectorLaunch: unknown,
  surface: T
): T {
  if (connectorLaunch && surface.paneKey) {
    noteAgentSession(runtime, surface.paneKey)
  }
  return surface
}

/** The same note for a terminal whose pane identity may still be on its way. */
export function noteAgentTerminal(
  runtime: AgentSessionMarkRuntime & { getTerminalPaneKey(handle: string): string | null },
  handle: string,
  attempts = MARK_ATTEMPTS
): void {
  let tries = 0
  const attempt = (): void => {
    tries += 1
    let paneKey: string | null = null
    try {
      paneKey = runtime.getTerminalPaneKey(handle)
    } catch {
      return
    }
    if (paneKey) {
      noteAgentSession(runtime, paneKey, attempts)
    } else if (tries < attempts) {
      setTimeout(attempt, MARK_RETRY_MS).unref?.()
    }
  }
  attempt()
}
