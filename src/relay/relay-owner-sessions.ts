/**
 * The sessions this relay runs, read from its own evidence: a PTY it holds is `live`, one it saw
 * exit is `exited`, and a pane it holds nothing for is `unverifiable`. The agent, its provider
 * session and its state come from the agent's own hook reports. A working session silent past
 * `RELAY_SILENT_AFTER_MS` is reported stalled (never restarted, never archived: the mechanical
 * steward on a relay only reports).
 */

import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { ConversationSource } from '../shared/conversation-source'
import type { SessionExecutionVerdict } from '../shared/session-host-verdict'
import type { SessionManageEntry, SessionManageState } from '../shared/session-manage-types'
import { pendingSessionAsk } from '../shared/session-questions'
import { getTuiAgentDetectCommands, isTuiAgent, TUI_AGENT_CONFIG } from '../shared/tui-agent-config'
import type { RelayOwnerPane } from './pty-handler'
import type { RelayTurnLedger } from './relay-owner-turns'

export const RELAY_SILENT_AFTER_MS = 10 * 60_000

export type RelayOwnerFacts = {
  panes(): RelayOwnerPane[]
  status(paneKey: string): AgentHookEventPayload | null
  /** When this relay saw the pane's PTY exit; null when it did not. */
  exitedAt(paneKey: string): number | null
  foreground(ptyId: string): Promise<string | null>
  write(ptyId: string, data: string): boolean
  now(): number
}

export type RelayOwnerSession = {
  paneKey: string
  pane: RelayOwnerPane | null
  source: ConversationSource | null
  agent: string | null
  providerSessionId: string | null
  verdict: SessionExecutionVerdict
  state: SessionManageState
  statusAt: number | null
  turnRevision: string | null
}

const STATE_OF: Record<string, SessionManageState> = {
  working: 'working',
  blocked: 'awaiting-user',
  waiting: 'awaiting-user',
  done: 'idle'
}

export function relayOwnerSession(
  facts: RelayOwnerFacts,
  turns: RelayTurnLedger,
  paneKey: string,
  pane: RelayOwnerPane | null = facts.panes().find((candidate) => candidate.paneKey === paneKey) ??
    null
): RelayOwnerSession {
  const status = facts.status(paneKey)
  const worktreeId = pane?.worktreeId ?? status?.worktreeId ?? null
  const verdict: SessionExecutionVerdict = pane
    ? pane.alive
      ? 'live'
      : 'exited'
    : facts.exitedAt(paneKey) !== null
      ? 'exited'
      : 'unverifiable'
  const state: SessionManageState =
    verdict === 'exited'
      ? 'exited'
      : verdict === 'live' && status
        ? // Why: an async question (Codex's) rides the finished turn that asked it.
          pendingSessionAsk(status.payload)
          ? 'awaiting-user'
          : (STATE_OF[status.payload.state] ?? 'unknown')
        : 'unknown'
  return {
    paneKey,
    pane,
    source: worktreeId ? { worktreeId, paneKey, kind: 'pty' } : null,
    agent: status?.payload.agentType ?? null,
    providerSessionId: status?.providerSession?.id ?? null,
    verdict,
    state,
    statusAt: turns.lastReportAt(paneKey),
    turnRevision: turns.revision(paneKey)
  }
}

export function relayOwnerSessions(
  facts: RelayOwnerFacts,
  turns: RelayTurnLedger
): RelayOwnerSession[] {
  return facts.panes().map((pane) => relayOwnerSession(facts, turns, pane.paneKey, pane))
}

/** The agent it reports is the process in its terminal's foreground now. */
export async function relayAgentHoldsTerminal(
  facts: RelayOwnerFacts,
  session: RelayOwnerSession
): Promise<boolean> {
  if (!session.pane?.alive || !session.agent || !isTuiAgent(session.agent)) {
    return false
  }
  const foreground = await facts.foreground(session.pane.ptyId).catch(() => null)
  return (
    foreground !== null &&
    getTuiAgentDetectCommands(TUI_AGENT_CONFIG[session.agent]).includes(foreground)
  )
}

/** The presentation projection a Mac shows for it; never execution evidence. */
export function relayOwnerEntry(
  facts: RelayOwnerFacts,
  session: RelayOwnerSession
): SessionManageEntry {
  const silent =
    session.state === 'working' &&
    session.statusAt !== null &&
    facts.now() - session.statusAt > RELAY_SILENT_AFTER_MS
  return {
    paneKey: session.paneKey,
    tabId: session.pane?.tabId ?? null,
    terminal: null,
    title: session.agent ?? 'Terminal',
    agent: session.agent ?? 'terminal',
    kind: 'terminal',
    worktreeId: session.source?.worktreeId ?? '',
    worktreePath: null,
    workspace: '',
    hostId: null,
    folder: null,
    saved: false,
    archived: false,
    pinned: false,
    verdict: session.verdict,
    state: session.state,
    stateBasis: session.state === 'unknown' ? 'none' : 'hook',
    agentForeground: null,
    lastActivityAt: session.statusAt,
    waitingOn: silent ? 'It has been working without a report for over 10 minutes.' : null,
    pendingSteps: [],
    queueLength: 0,
    keepGoing: false,
    ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
    ...(silent
      ? { stalled: { at: session.statusAt!, reason: 'Working without a report for 10 minutes.' } }
      : {})
  }
}
