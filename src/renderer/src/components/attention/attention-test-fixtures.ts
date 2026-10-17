import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AgentPaneSnapshotInputs } from './use-agent-pane-snapshot'
import type { AttentionPane } from './agent-pane-snapshot'

export const ATTENTION_FIXTURE_NOW = 1_000_000_000
export const ATTENTION_FIXTURE_LEAF_A = '11111111-1111-4111-8111-111111111111'
export const ATTENTION_FIXTURE_LEAF_B = '22222222-2222-4222-8222-222222222222'

export function attentionFixtureWorktree(id: string, displayName: string, repoId = 'r1'): Worktree {
  return {
    id,
    repoId,
    path: `/${repoId}/${id}`,
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: ATTENTION_FIXTURE_NOW
  }
}

export function attentionFixtureTab(id: string, worktreeId: string, ptyId: string): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId,
    title: `Terminal ${id}`,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: ATTENTION_FIXTURE_NOW,
    launchAgent: 'claude'
  }
}

export function attentionFixtureEntry(
  paneKey: string,
  tabId: string,
  worktreeId: string,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    paneKey,
    state: 'working',
    prompt: 'do the thing',
    updatedAt: ATTENTION_FIXTURE_NOW,
    stateStartedAt: ATTENTION_FIXTURE_NOW - 5_000,
    stateHistory: [],
    agentType: 'claude',
    tabId,
    worktreeId,
    ...overrides
  }
}

/** Two worktrees, one single-leaf tab each, both PTYs live. */
export function attentionFixtureInputs(
  overrides: Partial<AgentPaneSnapshotInputs> = {}
): AgentPaneSnapshotInputs {
  const tabA = attentionFixtureTab('tab-a', 'w1', 'pty-a')
  const tabB = attentionFixtureTab('tab-b', 'w2', 'pty-b')
  return {
    repos: [
      {
        id: 'r1',
        path: '/r1',
        displayName: 'Repo One',
        badgeColor: '#000',
        addedAt: 1,
        kind: 'git'
      }
    ],
    worktreesByRepo: {
      r1: [attentionFixtureWorktree('w1', 'wt-one'), attentionFixtureWorktree('w2', 'wt-two')]
    },
    tabsByWorktree: { w1: [tabA], w2: [tabB] },
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId: {
      'tab-a': {
        root: { type: 'leaf', leafId: ATTENTION_FIXTURE_LEAF_A },
        activeLeafId: ATTENTION_FIXTURE_LEAF_A,
        expandedLeafId: null,
        ptyIdsByLeafId: { [ATTENTION_FIXTURE_LEAF_A]: 'pty-a' }
      },
      'tab-b': {
        root: { type: 'leaf', leafId: ATTENTION_FIXTURE_LEAF_B },
        activeLeafId: ATTENTION_FIXTURE_LEAF_B,
        expandedLeafId: null,
        ptyIdsByLeafId: { [ATTENTION_FIXTURE_LEAF_B]: 'pty-b' }
      }
    },
    ptyIdsByTabId: { 'tab-a': ['pty-a'], 'tab-b': ['pty-b'] },
    runtimePaneTitlesByTabId: {},
    folderWorkspaces: [],
    acknowledgedAgentsByPaneKey: {},
    settings: null,
    agentStatusEpoch: 0,
    ...overrides
  } as AgentPaneSnapshotInputs
}

export const ATTENTION_FIXTURE_PANE_A = makePaneKey('tab-a', ATTENTION_FIXTURE_LEAF_A)
export const ATTENTION_FIXTURE_PANE_B = makePaneKey('tab-b', ATTENTION_FIXTURE_LEAF_B)

export function attentionFixturePane(overrides: Partial<AttentionPane> = {}): AttentionPane {
  return {
    paneKey: ATTENTION_FIXTURE_PANE_B,
    portalPaneKey: ATTENTION_FIXTURE_PANE_B,
    worktreeId: 'w2',
    tabId: 'tab-b',
    leafId: ATTENTION_FIXTURE_LEAF_B,
    agentType: 'claude',
    bucket: 'attention',
    dotState: 'waiting',
    cause: 'waiting',
    unseen: true,
    title: 'Pick a deploy target',
    stateChangedAt: ATTENTION_FIXTURE_NOW - 60_000,
    repoName: 'Repo One',
    worktreeName: 'wt-two',
    ...overrides
  }
}
