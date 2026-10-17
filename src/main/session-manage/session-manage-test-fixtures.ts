import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import type { TerminalAgentEvidence } from '../runtime/terminal-agent-evidence'
import type { TerminalAgentProcessProof } from '../runtime/terminal-agent-process'
import type { SessionObserveSources } from './session-manage-observe'

export function sidebarRow(
  overrides: Partial<SessionManageSidebarRow> = {}
): SessionManageSidebarRow {
  return {
    rowKey: '["local","repo::/w","tab-1:leaf-1"]',
    viewKey: 'pane:tab-1:leaf-1',
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    kind: 'terminal',
    structuredSessionId: null,
    worktreeId: 'repo::/w',
    hostId: 'local',
    hostUnavailable: false,
    title: 'Parser fix',
    agent: 'claude',
    workspace: 'repo / w',
    worktreePath: '/w',
    repoId: 'repo',
    repoLabel: 'repo',
    branch: 'feat/parser',
    workspaceKind: 'git',
    folderId: null,
    folder: null,
    saved: false,
    archived: false,
    archivedByHand: false,
    pinned: false,
    launchPending: false,
    resumable: false,
    shellForeground: false,
    folded: false,
    ...overrides
  }
}

/** The pid proof that a recognized agent holds the terminal's foreground, since before any report. */
export function agentProcess(
  overrides: Partial<TerminalAgentProcessProof> = {}
): TerminalAgentProcessProof {
  return {
    ptyId: 'pty-1',
    incarnationId: 'inc-1',
    rootPid: 100,
    pid: 200,
    pgid: 200,
    startTimeMs: -60_000,
    agent: 'claude',
    via: 'command-line',
    ...overrides
  }
}

/** Claude's own process in the foreground; its screen shows neither a turn nor a finished one. */
export function agentEvidence(
  overrides: Partial<TerminalAgentEvidence> = {}
): TerminalAgentEvidence {
  return {
    foreground: { kind: 'agent', agent: 'claude' },
    process: agentProcess(),
    tree: { kind: 'other' },
    screen: { blocked: null, working: false, turnDone: false, readyPrompt: false },
    ...overrides
  }
}

/** A live, idle Claude pane by default; each reading can be replaced. */
export function observeSources(
  overrides: Partial<SessionObserveSources> = {}
): SessionObserveSources {
  return {
    resolvePane: () => ({ handle: 'term_1', connected: true, ptyId: 'pty-1' }),
    livenessUnverifiable: () => null,
    agentStatus: async () => ({ running: true, status: 'idle' }),
    // Sent by the agent process `agentProcess()` proves (pid 200).
    hook: () => ({ state: 'done', interactivePrompt: null, updatedAt: 1_000, agentPid: 200 }),
    exitReceipt: () => true,
    // Idle by its title: a report never makes it idle on its own.
    titleStatus: () => 'idle',
    lastHook: () => null,
    evidence: async () => agentEvidence(),
    chat: () => null,
    queue: () => null,
    ownSteps: async () => [],
    keepGoing: () => false,
    ...overrides
  }
}

export function manageEntry(overrides: Partial<SessionManageEntry> = {}): SessionManageEntry {
  return {
    paneKey: 'tab-2:leaf-2',
    tabId: 'tab-2',
    terminal: 'term_2',
    title: 'Ads session',
    agent: 'claude',
    kind: 'terminal',
    worktreeId: 'repo::/ads',
    worktreePath: '/ads',
    workspace: 'repo / ads',
    hostId: 'local',
    folder: null,
    saved: false,
    archived: false,
    pinned: false,
    verdict: 'live',
    state: 'idle',
    stateBasis: 'hook',
    agentForeground: true,
    lastActivityAt: 1_000,
    waitingOn: null,
    pendingSteps: [],
    queueLength: 0,
    keepGoing: false,
    ...overrides
  }
}
