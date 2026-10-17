import type { AutomationDefinitionContext } from '../../../shared/automation-definition-context'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AutomationRun } from '../../../shared/automations-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { readAutomationRunProviderSession } from '../../../shared/automation-run-provider-session'
import type { AppState } from '@/store/types'
import {
  readLastAutomationTerminalInputAt,
  readLastTerminalInputAt
} from './terminal-input-activity-coalescing'

export type ReusableAutomationSession = {
  tabId: string
  ptyId: string
  paneKey: string
}

export function findReusableAutomationSession(args: {
  automationId: string
  tools?: AutomationDefinitionContext['tools']
  agentId: TuiAgent
  worktreeId: string
  currentRunId: string
  runs: AutomationRun[]
  state: Pick<
    AppState,
    | 'agentStatusByPaneKey'
    | 'ptyIdsByTabId'
    | 'terminalLayoutsByTabId'
    | 'unifiedTabsByWorktree'
    | 'lastTerminalInputAtByPaneKey'
  >
}): ReusableAutomationSession | null {
  const { automationId, agentId, worktreeId, currentRunId, runs, state } = args
  const worktreeTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const terminalTabIds = new Set(
    worktreeTabs.filter((tab) => tab.contentType === 'terminal').map((tab) => tab.entityId)
  )
  const candidates = runs
    .filter(
      (run) =>
        run.id !== currentRunId &&
        run.automationId === automationId &&
        run.workspaceId === worktreeId &&
        // Why dispatch_failed too: a turn that failed (usage limit, refused tool) leaves
        // its pane live and idle; the next run belongs in that session, not in a new tab.
        (run.status === 'completed' || run.status === 'dispatch_failed') &&
        JSON.stringify(run.definitionSnapshot?.tools ?? null) ===
          JSON.stringify(args.tools ?? null) &&
        Boolean(run.terminalPaneKey) &&
        Boolean(run.terminalPtyId)
    )
    .sort((left, right) => right.createdAt - left.createdAt)

  for (const run of candidates) {
    const exactPane = findReusableExactRunPane({ state, terminalTabIds, agentId, run })
    if (exactPane) {
      return exactPane
    }
  }
  // Why: Claude keeps a thread usable from any process, so when the run's own PTY is gone
  // but its recorded thread is open in a live idle pane of this workspace (an agent
  // restarted in place, say), the prompt goes there. Codex refuses a thread that is open
  // elsewhere, so decideAutomationThreadResume keeps starting it fresh.
  if (agentId === 'claude') {
    for (const run of candidates) {
      const thread = readAutomationRunProviderSession(run, agentId)
      const threadPane = thread
        ? findReusableThreadPane({
            state,
            terminalTabIds,
            agentId,
            run,
            threadId: thread.providerSessionId
          })
        : null
      if (threadPane) {
        return threadPane
      }
    }
  }
  return null
}

function isSessionTakenOver(
  state: Pick<AppState, 'lastTerminalInputAtByPaneKey'>,
  paneKey: string,
  run: AutomationRun
): boolean {
  // Why: input after the run started means a person (or another agent) took the session
  // over; the routine's next run gets its own session instead of landing in their chat.
  // The routine's own prompt is input too, so only stamps after its latest write count.
  const lastInputAt = readLastTerminalInputAt(state.lastTerminalInputAtByPaneKey ?? {}, paneKey)
  return (
    lastInputAt !== undefined &&
    lastInputAt >
      Math.max(run.dispatchedAt ?? run.createdAt, readLastAutomationTerminalInputAt(paneKey) ?? 0)
  )
}

function findReusableThreadPane({
  state,
  terminalTabIds,
  agentId,
  run,
  threadId
}: {
  state: Pick<
    AppState,
    | 'agentStatusByPaneKey'
    | 'ptyIdsByTabId'
    | 'terminalLayoutsByTabId'
    | 'lastTerminalInputAtByPaneKey'
  >
  terminalTabIds: Set<string>
  agentId: TuiAgent
  run: AutomationRun
  threadId: string
}): ReusableAutomationSession | null {
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    if (entry?.providerSession?.key !== 'session_id' || entry.providerSession.id !== threadId) {
      continue
    }
    const parsed = parsePaneKey(paneKey)
    if (!parsed || !terminalTabIds.has(parsed.tabId) || isSessionTakenOver(state, paneKey, run)) {
      continue
    }
    if (!isReusableAgentStatus(entry, agentId)) {
      continue
    }
    const ptyId = state.terminalLayoutsByTabId[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId]
    if (!ptyId || !isRunPtyLiveInPane(state, parsed.tabId, parsed.leafId, ptyId)) {
      continue
    }
    return { tabId: parsed.tabId, ptyId, paneKey }
  }
  return null
}

function findReusableExactRunPane({
  state,
  terminalTabIds,
  agentId,
  run
}: {
  state: Pick<
    AppState,
    | 'agentStatusByPaneKey'
    | 'ptyIdsByTabId'
    | 'terminalLayoutsByTabId'
    | 'lastTerminalInputAtByPaneKey'
  >
  terminalTabIds: Set<string>
  agentId: TuiAgent
  run: AutomationRun
}): ReusableAutomationSession | null {
  if (!run.terminalPaneKey || !run.terminalPtyId) {
    return null
  }
  const parsed = parsePaneKey(run.terminalPaneKey)
  if (!parsed || !terminalTabIds.has(parsed.tabId)) {
    return null
  }
  if (isSessionTakenOver(state, run.terminalPaneKey, run)) {
    return null
  }
  const entry = state.agentStatusByPaneKey[run.terminalPaneKey]
  if (!entry || !isReusableAgentStatus(entry, agentId)) {
    return null
  }
  if (!isRunPtyLiveInPane(state, parsed.tabId, parsed.leafId, run.terminalPtyId)) {
    return null
  }
  return { tabId: parsed.tabId, ptyId: run.terminalPtyId, paneKey: run.terminalPaneKey }
}

function isReusableAgentStatus(entry: AgentStatusEntry, agentId: TuiAgent): boolean {
  if (entry.state !== 'done') {
    return false
  }
  return !entry.agentType || entry.agentType === 'unknown' || entry.agentType === agentId
}

function isRunPtyLiveInPane(
  state: Pick<AppState, 'ptyIdsByTabId' | 'terminalLayoutsByTabId'>,
  tabId: string,
  leafId: string,
  ptyId: string
): boolean {
  if (!state.ptyIdsByTabId[tabId]?.includes(ptyId)) {
    return false
  }
  const layoutPtyId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
  return layoutPtyId === undefined || layoutPtyId === ptyId
}
