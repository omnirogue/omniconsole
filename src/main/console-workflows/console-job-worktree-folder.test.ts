import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { ConsoleLocalJob } from './console-local-execution-contract'

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn(async () => ({ stdout: 'https://github.com/omnirogue/omni-ide.git\n' }))
}))

import { resolveConsoleJobRepository } from './console-job-worktree'

const attached: Repo = {
  id: 'repo-omni',
  path: '/work/omni-ide',
  displayName: 'omni-ide',
  badgeColor: '#000',
  addedAt: 0,
  kind: 'git'
}
const job = { repo: 'omnirogue/omni-ide', baseBranch: 'main' } as ConsoleLocalJob

function runtime(resolved: Repo | null) {
  return {
    showManagedTerminalWorkspace: vi.fn(async () => ({
      id: 'folder:ops',
      repoId: 'folder-workspace:pg',
      hostId: 'local'
    })),
    showRepo: vi.fn(async () => {
      throw new Error('folder workspaces have no repo')
    }),
    resolveFolderWorkspaceJobRepo: vi.fn(() => resolved)
  } as never
}

describe('resolveConsoleJobRepository in a folder workspace', () => {
  it('runs against the attached repo that is the job repository', async () => {
    const rt = runtime(attached)
    await expect(resolveConsoleJobRepository(rt, 'folder:ops', job)).resolves.toBe(attached)
    expect(
      (rt as { resolveFolderWorkspaceJobRepo: ReturnType<typeof vi.fn> })
        .resolveFolderWorkspaceJobRepo
    ).toHaveBeenCalledWith('ops', 'github.com/omnirogue/omni-ide')
  })

  it('explains how to attach the repo instead of failing on the folder', async () => {
    await expect(resolveConsoleJobRepository(runtime(null), 'folder:ops', job)).rejects.toThrow(
      'Attach omnirogue/omni-ide to this folder workspace to run Git jobs here'
    )
  })
})
