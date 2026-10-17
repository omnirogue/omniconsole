import { describe, expect, it, vi } from 'vitest'
import {
  resolveLocalWorkerPlacement,
  resolveWorkerAccountEnv,
  resolveWorkerStartCwd
} from './orchestration-worker-placement'

const workspacePath = '/workspace/brief'

describe('resolveWorkerStartCwd', () => {
  it('resolves a relative folder against the workspace root', () => {
    expect(
      resolveWorkerStartCwd({
        requestedCwd: '.omni/runs/run_1/task_a',
        workspacePath,
        createsWorktree: false,
        terminal: undefined
      })
    ).toBe('/workspace/brief/.omni/runs/run_1/task_a')
  })

  it('accepts an absolute folder inside the workspace', () => {
    expect(
      resolveWorkerStartCwd({
        requestedCwd: '/workspace/brief/.omni/runs/run_1/task_a',
        workspacePath,
        createsWorktree: false,
        terminal: undefined
      })
    ).toBe('/workspace/brief/.omni/runs/run_1/task_a')
  })

  it('refuses a folder outside the workspace', () => {
    for (const requestedCwd of ['../elsewhere', '/etc', '/workspace/brief-other', 'a/../../b']) {
      expect(() =>
        resolveWorkerStartCwd({
          requestedCwd,
          workspacePath,
          createsWorktree: false,
          terminal: undefined
        })
      ).toThrow(/outside this workspace/)
    }
  })

  it('refuses a folder with a reused terminal or a new worktree', () => {
    expect(() =>
      resolveWorkerStartCwd({
        requestedCwd: 'sub',
        workspacePath,
        createsWorktree: false,
        terminal: 'term_1'
      })
    ).toThrow(/existing terminal/)
    expect(() =>
      resolveWorkerStartCwd({
        requestedCwd: 'sub',
        workspacePath,
        createsWorktree: true,
        terminal: undefined
      })
    ).toThrow(/new worktree starts at its own root/)
  })

  it('passes through when no folder was requested', () => {
    expect(
      resolveWorkerStartCwd({
        requestedCwd: undefined,
        workspacePath,
        createsWorktree: false,
        terminal: undefined
      })
    ).toBeUndefined()
  })
})

describe('resolveWorkerAccountEnv', () => {
  const runtime = {
    getAgentAccountSettings: () => ({
      agentAccountProfiles: [
        { id: 'work', label: 'Work', agent: 'claude' as const, configDir: '/homes/work' }
      ]
    })
  } as never

  it('resolves a named profile to its config directory', () => {
    expect(
      resolveWorkerAccountEnv({
        runtime,
        agent: 'claude',
        accountChoiceId: 'profile:work',
        terminal: undefined
      })
    ).toEqual({ CLAUDE_CONFIG_DIR: '/homes/work' })
  })

  it('refuses an account the agent does not have instead of using the default sign-in', () => {
    expect(() =>
      resolveWorkerAccountEnv({
        runtime,
        agent: 'claude',
        accountChoiceId: 'profile:gone',
        terminal: undefined
      })
    ).toThrow(/is not configured for claude/)
  })

  it('refuses an account choice when the terminal already exists', () => {
    expect(() =>
      resolveWorkerAccountEnv({
        runtime,
        agent: 'claude',
        accountChoiceId: 'profile:work',
        terminal: 'term_1'
      })
    ).toThrow(/create the agent terminal/)
  })

  it('returns nothing when no account was named', () => {
    expect(
      resolveWorkerAccountEnv({
        runtime,
        agent: 'claude',
        accountChoiceId: undefined,
        terminal: undefined
      })
    ).toBeUndefined()
  })
})

describe('resolveLocalWorkerPlacement', () => {
  it('creates a top-level worktree from a folder coordinator with an explicit repo', async () => {
    const runtime = {
      showManagedWorktree: vi.fn(async () => {
        throw new Error('selector_not_found')
      }),
      showManagedTerminalWorkspace: vi.fn(async () => ({
        id: 'folder:work',
        repoId: 'folder-workspace:g',
        hostId: 'local',
        path: '/w'
      })),
      showRepo: vi.fn(async () => ({ id: 'repo', kind: 'git' }))
    }

    const placement = await resolveLocalWorkerPlacement({
      runtime: runtime as never,
      coordinatorWorktreeId: 'folder:work',
      params: {
        task: 'task_worker',
        from: 'term_coordinator',
        worktree: 'new-top-level',
        repo: 'id:repo'
      },
      createsWorktree: true,
      agent: undefined
    })

    expect(placement.creationWorktree?.id).toBe('folder:work')
    expect(placement.resolvedWorktree).toBeUndefined()
    expect(runtime.showManagedTerminalWorkspace).toHaveBeenCalledWith('id:folder:work')
    expect(runtime.showManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.showRepo).toHaveBeenCalledWith('id:repo')
  })

  it.each([{ worktree: 'new-child', repo: 'id:repo' }, { worktree: 'new-top-level' }])(
    'refuses unsupported folder coordinator placement %j before resolving anything',
    async (params) => {
      const runtime = {
        showManagedWorktree: vi.fn(async () => {
          throw new Error('selector_not_found')
        }),
        showManagedTerminalWorkspace: vi.fn(async () => ({
          id: 'folder:work',
          repoId: 'folder-workspace:g',
          hostId: 'local',
          path: '/w'
        })),
        showRepo: vi.fn(async () => ({ id: 'repo', kind: 'git' }))
      }

      await expect(
        resolveLocalWorkerPlacement({
          runtime: runtime as never,
          coordinatorWorktreeId: 'folder:work',
          params: { task: 'task_worker', from: 'term_coordinator', ...params },
          createsWorktree: true,
          agent: undefined
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(runtime.showManagedWorktree).not.toHaveBeenCalled()
      expect(runtime.showManagedTerminalWorkspace).not.toHaveBeenCalled()
      expect(runtime.showRepo).not.toHaveBeenCalled()
    }
  )

  it('keeps the git coordinator on the managed worktree resolver', async () => {
    const runtime = {
      showManagedWorktree: vi.fn(async () => ({ id: 'repo::parent', repoId: 'repo' })),
      showManagedTerminalWorkspace: vi.fn(),
      showRepo: vi.fn(async () => ({ id: 'repo', kind: 'git' }))
    }

    await resolveLocalWorkerPlacement({
      runtime: runtime as never,
      coordinatorWorktreeId: 'repo::parent',
      params: { task: 'task_worker', from: 'term_coordinator', worktree: 'new-child' },
      createsWorktree: true,
      agent: undefined
    })

    expect(runtime.showManagedWorktree).toHaveBeenCalledWith('id:repo::parent')
    expect(runtime.showManagedTerminalWorkspace).not.toHaveBeenCalled()
  })
})
