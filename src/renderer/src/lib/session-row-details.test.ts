import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { selectOrchestrationChildren, selectSessionWorktrees } from './session-row-details'

function status(paneKey: string, extra: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey,
    stateHistory: [],
    ...extra
  }
}

const LEAD = 'tab-a:leaf-lead'

describe('selectOrchestrationChildren', () => {
  it('returns rows whose parent pane is this session', () => {
    const child = status('tab-c:leaf-w', {
      orchestration: { taskId: 't', dispatchId: 'd', parentPaneKey: LEAD }
    })
    const other = status('tab-d:leaf-x', {
      orchestration: {
        taskId: 't',
        dispatchId: 'd',
        parentPaneKey: 'tab-z:leaf'
      }
    })
    expect(selectOrchestrationChildren({ [LEAD]: status(LEAD), a: child, b: other }, LEAD)).toEqual(
      [child]
    )
    expect(selectOrchestrationChildren({ a: child }, null)).toEqual([])
  })
})

describe('selectSessionWorktrees', () => {
  const worktree = (id: string, branch: string, path: string) =>
    ({
      id,
      displayName: id.split('::')[1],
      branch,
      path
    }) as unknown as Worktree
  const lineage = (worktreeId: string, extra: Partial<WorktreeLineage>): WorktreeLineage => ({
    worktreeId,
    worktreeInstanceId: 'i',
    parentWorktreeId: 'repo::main',
    parentWorktreeInstanceId: 'p',
    origin: 'orchestration',
    capture: { source: 'terminal-context', confidence: 'explicit' },
    createdAt: 1,
    ...extra
  })

  it('joins own worktree, worktrees created by the terminal handle and worker workspaces', () => {
    const links = selectSessionWorktrees({
      sessionWorktreeId: 'repo::main',
      entry: status(LEAD, { terminalHandle: 'term_lead' }),
      orchestrationChildren: [status('tab-w:leaf', { worktreeId: 'repo::worker' })],
      lineageById: {
        'repo::feat': lineage('repo::feat', {
          createdByTerminalHandle: 'term_lead'
        }),
        'repo::else': lineage('repo::else', {
          createdByTerminalHandle: 'term_other'
        })
      },
      worktreesByRepo: {
        repo: [
          worktree('repo::main', 'refs/heads/main', '/r/main'),
          worktree('repo::feat', 'refs/heads/feat/x', '/r/feat'),
          worktree('repo::worker', 'refs/heads/w', '/r/w')
        ]
      },
      folderWorkspaces: []
    })
    expect(links.map((link) => [link.id, link.relation, link.branch, link.path])).toEqual([
      ['repo::main', 'own', 'main', '/r/main'],
      ['repo::feat', 'created', 'feat/x', '/r/feat'],
      ['repo::worker', 'worker', 'w', '/r/w']
    ])
  })

  it('keeps a lineage entry that matches by orchestration run id when the child handle differs', () => {
    const links = selectSessionWorktrees({
      sessionWorktreeId: null,
      entry: status(LEAD, {
        terminalHandle: 'term_lead',
        orchestration: {
          taskId: 't',
          dispatchId: 'd',
          orchestrationRunId: 'run_1'
        }
      }),
      orchestrationChildren: [],
      lineageById: {
        'repo::child': lineage('repo::child', {
          orchestrationRunId: 'run_1',
          coordinatorHandle: 'term_child',
          createdByTerminalHandle: 'term_child'
        }),
        'repo::other': lineage('repo::other', {
          orchestrationRunId: 'run_2',
          coordinatorHandle: 'term_child'
        })
      },
      worktreesByRepo: {
        repo: [worktree('repo::child', 'refs/heads/child', '/r/child')]
      },
      folderWorkspaces: []
    })
    expect(links.map((link) => [link.id, link.relation])).toEqual([['repo::child', 'created']])
  })

  it('resolves folder workspaces, which have no branch', () => {
    const folder = {
      id: 'fw1',
      name: 'Designs',
      folderPath: '/Users/me/Designs'
    } as FolderWorkspace
    const links = selectSessionWorktrees({
      sessionWorktreeId: 'folder:fw1',
      entry: null,
      orchestrationChildren: [],
      lineageById: {},
      worktreesByRepo: {},
      folderWorkspaces: [folder]
    })
    expect(links).toEqual([
      {
        id: 'folder:fw1',
        name: 'Designs',
        branch: null,
        path: '/Users/me/Designs',
        relation: 'own',
        folder: true
      }
    ])
  })
})
