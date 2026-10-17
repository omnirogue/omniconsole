/**
 * Binds a Jira issue to the session that just handed it off: a successful `omni-jira comment <KEY>`
 * or a `gh pr create|edit|ready` naming the key. Only the 160-character tool preview is visible
 * here, so a key further into a PR body needs `omni work bind`.
 */

import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { WorkBindRequest, WorkBindResult } from './work-delivery-bind'

const HANDOFF = /\bomni-jira\s+comment\s+([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/
const PULL_REQUEST = /\bgh\s+pr\s+(?:create|edit|ready)\b/
const PR_KEY = /(?:\bJira:\s*|\b)([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/

export type AutoBind = { jira: string; source: 'handoff' | 'pull-request' }

export function autoBindFromToolEvent(event: AgentHookEventPayload): AutoBind | null {
  const command = event.payload.toolInput
  if (
    event.hookEventName !== 'PostToolUse' ||
    event.payload.failed === true ||
    event.payload.toolName?.toLowerCase() !== 'bash' ||
    !command
  ) {
    return null
  }
  const handoff = HANDOFF.exec(command)
  if (handoff) {
    return { jira: handoff[1]!, source: 'handoff' }
  }
  const key = PULL_REQUEST.test(command) ? PR_KEY.exec(command.replace(PULL_REQUEST, ' ')) : null
  return key ? { jira: key[1]!, source: 'pull-request' } : null
}

/** Binds on each matching tool event from a local live pane; one bind per pane and issue per run. */
export function autoBindListener(deps: {
  rowOf: (paneKey: string) => Promise<{ worktreeId: string; title: string } | null>
  bind: (request: WorkBindRequest) => Promise<WorkBindResult>
}): (event: AgentHookEventPayload) => void {
  const bound = new Set<string>()
  return (event) => {
    if (event.connectionId !== null || event.isReplay || event.restoredUnconfirmed) {
      return
    }
    const match = autoBindFromToolEvent(event)
    const once = match ? `${event.paneKey}|${match.jira}` : null
    if (!match || !once || bound.has(once)) {
      return
    }
    bound.add(once)
    void deps
      .rowOf(event.paneKey)
      .then((row) =>
        row
          ? deps.bind({
              jira: match.jira,
              source: match.source,
              pane: { paneKey: event.paneKey, ...row }
            })
          : { ok: false as const, reason: 'pane not listed' }
      )
      .then((result) => {
        if (!result.ok) {
          bound.delete(once)
        }
      })
      .catch((error) => {
        bound.delete(once)
        console.warn(`[work-delivery] auto-bind of ${match.jira} failed:`, error)
      })
  }
}
