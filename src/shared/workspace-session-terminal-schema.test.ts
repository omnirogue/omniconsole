import { describe, expect, it } from 'vitest'
import { parseWorkspaceSession } from './workspace-session-schema'
import { createLocalWorkflowDraft } from './local-workflow-draft'
import { createEvolveDraft } from './evolve-workflow-draft'

describe('parseWorkspaceSession terminal fields', () => {
  it('retains a workflow execution and pending Start across session restore', () => {
    const draft = createLocalWorkflowDraft('council', 'Investigate recovery')
    draft.capability = 'working-agent'
    draft.attemptLimit = 1
    draft.maxHostAttempts = draft.callLimit
    draft.seats = [
      { id: 'seat-1', agent: 'claude', accountId: 'a' },
      { id: 'seat-2', agent: 'codex', accountId: 'b', model: 'gpt-5' },
      { id: 'seat-3', agent: 'grok', accountId: 'c', effort: 'high' }
    ]
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: 'workflow-tab',
      tabsByWorktree: {
        wt: [
          {
            id: 'workflow-tab',
            ptyId: null,
            worktreeId: 'wt',
            title: 'Terminal 1',
            customTitle: 'Council',
            color: null,
            sortOrder: 0,
            createdAt: 0,
            localWorkflow: {
              preset: 'council',
              prompt: draft.prompt,
              draft,
              executionId: 'execution-1',
              startRequest: { requestId: 'request-1', draft }
            }
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree.wt[0].localWorkflow).toEqual({
        preset: 'council',
        prompt: draft.prompt,
        draft,
        executionId: 'execution-1',
        startRequest: { requestId: 'request-1', draft }
      })
    }
  })

  it('retains the Build + Review pipeline anchor across session restore', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: 'review-tab',
      tabsByWorktree: {
        wt: [
          {
            id: 'review-tab',
            ptyId: null,
            worktreeId: 'wt',
            title: 'Terminal 1',
            customTitle: 'Build + Review',
            color: null,
            sortOrder: 0,
            createdAt: 0,
            localWorkflow: {
              preset: 'build-review',
              prompt: 'Build the feature',
              buildReviewPipelineId: 'pipeline-1',
              buildReviewDraft: {
                worktree: 'wt',
                objective: 'Build the feature',
                reviewFocus: 'Recovery',
                hubTaskId: 'btk_123',
                builder: { agent: 'codex' },
                reviewers: [{ id: 1, choice: { agent: 'claude' }, chosen: true }],
                maxReviewRounds: 3
              }
            }
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree.wt[0].localWorkflow).toMatchObject({
        preset: 'build-review',
        buildReviewPipelineId: 'pipeline-1',
        buildReviewDraft: { objective: 'Build the feature', hubTaskId: 'btk_123' }
      })
    }
  })

  it('retains an Evolve anchor with its run id and saved form across session restore', () => {
    const evolveDraft = { ...createEvolveDraft(), target: 'spec' as const, specPath: 'a/b.yaml' }
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: 'evolve-tab',
      tabsByWorktree: {
        wt: [
          {
            id: 'evolve-tab',
            ptyId: null,
            worktreeId: 'wt',
            title: 'Terminal 1',
            customTitle: 'Evolve',
            color: null,
            sortOrder: 0,
            createdAt: 0,
            localWorkflow: {
              preset: 'evolve',
              prompt: 'Evolve a/b.yaml on mw0001',
              executionId: 'evo_00000000-0000-4000-8000-000000000001',
              evolveDraft
            }
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree.wt[0].localWorkflow).toEqual({
        preset: 'evolve',
        prompt: 'Evolve a/b.yaml on mw0001',
        executionId: 'evo_00000000-0000-4000-8000-000000000001',
        evolveDraft
      })
    }
  })

  it('preserves terminal startup cwd while accepting older omitted fields', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt: [
          {
            id: 'tab1',
            ptyId: null,
            worktreeId: 'wt',
            title: 'Terminal 1',
            defaultTitle: 'Terminal 1',
            startupCwd: '/repo/packages/app',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          },
          {
            id: 'tab2',
            ptyId: null,
            worktreeId: 'wt',
            title: 'Terminal 2',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree.wt[0].startupCwd).toBe('/repo/packages/app')
      expect(result.value.tabsByWorktree.wt[1].startupCwd).toBeUndefined()
    }
  })

  it('drops a tab with an empty startup cwd instead of failing the session', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt: [
          {
            id: 'tab1',
            ptyId: null,
            worktreeId: 'wt',
            title: 'Terminal 1',
            defaultTitle: 'Terminal 1',
            startupCwd: '',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tabsByWorktree.wt).toEqual([])
    }
  })
})
