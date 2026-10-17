import { describe, expect, it } from 'vitest'
import { localRunNodeOutputDir, resolveLocalRunPlacement } from './local-run-placement'

const base = {
  workspacePath: '/work/brief',
  runId: 'run_1',
  taskId: 'task_a',
  nodeId: 'implement-a'
} as const

describe('resolveLocalRunPlacement', () => {
  it('keeps a sequential node in the workspace root, whatever the workspace kind', () => {
    for (const workspaceKind of ['folder', 'git'] as const) {
      expect(
        resolveLocalRunPlacement({
          ...base,
          workspaceKind,
          presetId: 'implement',
          parallel: false
        })
      ).toEqual({ worktree: 'current' })
    }
  })

  it('gives each parallel node of a folder workspace its own subfolder', () => {
    expect(
      resolveLocalRunPlacement({
        ...base,
        workspaceKind: 'folder',
        presetId: 'implement',
        parallel: true
      })
    ).toEqual({
      worktree: 'current',
      cwd: localRunNodeOutputDir('/work/brief', 'run_1', 'task_a')
    })
  })

  it('gives a parallel EDITING node of a git workspace its own child worktree', () => {
    expect(
      resolveLocalRunPlacement({
        ...base,
        workspaceKind: 'git',
        presetId: 'implement',
        parallel: true
      })
    ).toEqual({ worktree: 'new-child', name: 'run_1-implement-a' })
  })

  it('keeps a parallel READ-ONLY node of a git workspace on the current workspace', () => {
    for (const presetId of ['research', 'analyze', 'plan', 'verify', 'review'] as const) {
      expect(
        resolveLocalRunPlacement({ ...base, workspaceKind: 'git', presetId, parallel: true })
      ).toEqual({ worktree: 'current' })
    }
  })

  it('never asks a folder workspace for a worktree', () => {
    for (const presetId of ['implement', 'improve', 'synthesize', 'review'] as const) {
      const placement = resolveLocalRunPlacement({
        ...base,
        workspaceKind: 'folder',
        presetId,
        parallel: true
      })
      expect(placement.worktree).toBe('current')
      expect(placement.name).toBeUndefined()
    }
  })
})
