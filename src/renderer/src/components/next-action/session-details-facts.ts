import type { SessionAgentTemplateView } from '../../../../shared/session-agent-template'
import { translate } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { sidebarSessionStatusKey } from '@/lib/sidebar-session-source-identity'

/** The lifecycle badge beside the agent's name. Four words, no invented fifth state. */
export type AgentBadgeState = 'running' | 'idle' | 'stopped' | 'closed'

export type SessionDetailsMore = {
  receipts: { count: number; latest: number | null }
  verdicts: { count: number; latest: number | null }
  /** Changed files reported by the workspace store. */
  files: { count: number }
  timings: { startedAt: number | null; updatedAt: number | null }
}

export type SessionDetailsFacts = {
  session: SidebarSession
  agent: { name: string; state: AgentBadgeState; detail: string | null }
  /** The agent template it launched with, read against the templates as they are now. */
  agentTemplate?: SessionAgentTemplateView
  /** Where the work executes — a location, never an actor. */
  runsOn: string
  workspace: string
  savesTo: string
  /** `savesTo` names a Conversations folder rather than falling back to the workspace path. */
  savesToFolder?: boolean
  task: { id: string; title: string } | null
  more: SessionDetailsMore
}

/**
 * The badge from what the host reports, not from what a click hoped: no pane or an unavailable row
 * is `closed`; a live pane with no status yet is `idle`; an interrupted or provider-failed turn is
 * `stopped`. `blocked` and `waiting` are live-but-not-executing, so they read `idle` and keep their
 * exact state in the badge's title.
 */
export function agentBadgeState(
  session: Pick<SidebarSession, 'paneKey' | 'unavailable'> &
    Partial<Pick<SidebarSession, 'kind' | 'tabId'>>,
  status: Pick<AgentStatusEntry, 'state' | 'interrupted' | 'failed'> | undefined
): AgentBadgeState {
  // Why the status key, not the pane: a structured chat's row has no pane but is live all the same.
  if (session.unavailable || !sidebarSessionStatusKey(session)) {
    return 'closed'
  }
  if (!status) {
    return 'idle'
  }
  if (status.state === 'working') {
    return 'running'
  }
  return status.state === 'done' && (status.interrupted || status.failed) ? 'stopped' : 'idle'
}

export function agentBadgeLabel(state: AgentBadgeState): string {
  switch (state) {
    case 'running':
      return translate('nextAction.agentRunning', 'running')
    case 'idle':
      return translate('nextAction.agentIdle', 'idle')
    case 'stopped':
      return translate('nextAction.agentStopped', 'stopped')
    case 'closed':
      return translate('nextAction.agentClosed', 'closed')
  }
}

/** Everything behind "More", counted from the chain the host owns. Nothing is probed. */
export function sessionDetailsMore(
  chain: SessionChain | null | undefined,
  changedFiles = 0
): SessionDetailsMore {
  const outcomes = chain?.outcomeSet?.outcomes ?? []
  const receipts = outcomes.flatMap((outcome) => outcome.evidence)
  const verdicts = chain?.verdicts ?? []
  return {
    receipts: {
      count: receipts.length,
      latest: receipts.length ? Math.max(...receipts.map((entry) => entry.verifiedAt)) : null
    },
    verdicts: {
      count: verdicts.length,
      latest: verdicts.length ? Math.max(...verdicts.map((entry) => entry.consumedAt)) : null
    },
    files: { count: changedFiles },
    timings: { startedAt: chain?.createdAt ?? null, updatedAt: chain?.updatedAt ?? null }
  }
}

/** "2 · latest 14:02" — a count and, when there is one, when the last one landed. */
export function countAndLatest(entry: { count: number; latest: number | null }): string {
  if (!entry.count) {
    return translate('nextAction.none', 'none')
  }
  return entry.latest === null
    ? String(entry.count)
    : translate('nextAction.countLatest', '{{count}} · latest {{time}}', {
        count: entry.count,
        time: new Date(entry.latest).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      })
}

/** "started 13:48 · 23m", from the chain's own timestamps. */
export function timingsLabel(timings: SessionDetailsMore['timings']): string {
  if (timings.startedAt === null) {
    return translate('nextAction.none', 'none')
  }
  const started = new Date(timings.startedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })
  const minutes =
    timings.updatedAt === null
      ? null
      : Math.max(0, Math.round((timings.updatedAt - timings.startedAt) / 60_000))
  return minutes === null
    ? translate('nextAction.started', 'started {{time}}', { time: started })
    : translate('nextAction.startedFor', 'started {{time}} · {{minutes}}m', {
        time: started,
        minutes
      })
}
