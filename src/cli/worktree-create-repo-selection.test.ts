import { describe, expect, it, vi } from 'vitest'
import { RuntimeClientError } from './runtime-client'
import {
  getFolderParentWorkspace,
  resolveCreateRepoSelector,
  resolveFolderWorkspaceCreateRepo
} from './worktree-create-repo-selection'

function client(result: unknown) {
  return {
    call: vi.fn(async () => {
      if (result instanceof Error) {
        throw result
      }
      return { result }
    })
  } as never
}

describe('getFolderParentWorkspace', () => {
  it('picks the first folder key and ignores worktree keys', () => {
    expect(getFolderParentWorkspace('worktree:r::/p', 'folder:ops')).toBe('folder:ops')
    expect(getFolderParentWorkspace(undefined, 'worktree:r::/p')).toBeUndefined()
  })
})

describe('resolveFolderWorkspaceCreateRepo', () => {
  it('returns the attached repo selector', async () => {
    await expect(
      resolveFolderWorkspaceCreateRepo(
        client({ resolution: { kind: 'resolved', repoSelector: 'id:r1', displayName: 'r' } }),
        'folder:ops',
        undefined
      )
    ).resolves.toBe('id:r1')
  })

  it('surfaces a host explanation as an argument error', async () => {
    await expect(
      resolveFolderWorkspaceCreateRepo(
        client({ resolution: { kind: 'error', message: 'Ops has no attached repo yet.' } }),
        'folder:ops',
        undefined
      )
    ).rejects.toThrow('Ops has no attached repo yet.')
  })

  it('keeps the old lookup on a host that predates attached repos', async () => {
    await expect(
      resolveFolderWorkspaceCreateRepo(
        client(new RuntimeClientError('method_not_found', 'Unknown method')),
        'folder:ops',
        'omni-ide'
      )
    ).resolves.toBeUndefined()
  })

  it('does nothing without a folder parent', async () => {
    const c = client({})
    await expect(resolveFolderWorkspaceCreateRepo(c, undefined, 'x')).resolves.toBeUndefined()
  })
})

describe('resolveCreateRepoSelector (review F4)', () => {
  const base = {
    projectRepoSelector: undefined,
    explicitRepo: undefined,
    cwdParentWorktree: 'id:repo-cwd::/work/wt',
    folderParentWorkspace: 'folder:ops'
  }

  it('asks the folder first, passing the cwd repo as a hint', async () => {
    const c = client({
      resolution: { kind: 'resolved', repoSelector: 'id:repo-attached', displayName: 'a' }
    })
    await expect(resolveCreateRepoSelector({ client: c, ...base })).resolves.toBe(
      'id:repo-attached'
    )
    expect((c as { call: ReturnType<typeof vi.fn> }).call).toHaveBeenCalledWith(
      'folderWorkspace.resolveRepoForCreate',
      { folderWorkspace: 'folder:ops', cwdRepoId: 'repo-cwd' }
    )
  })

  it('falls back to the cwd repo when the folder cannot decide', async () => {
    const c = client({
      resolution: { kind: 'error', code: 'ambiguous', message: 'Ops has several attached repos' }
    })
    await expect(resolveCreateRepoSelector({ client: c, ...base })).resolves.toBe('id:repo-cwd')
  })

  it('stops on a stale attachment or a transport failure instead of using the cwd repo', async () => {
    const stale = client({
      resolution: { kind: 'error', code: 'stale-attachment', message: 'no longer a project here' }
    })
    await expect(resolveCreateRepoSelector({ client: stale, ...base })).rejects.toThrow(
      'no longer a project here'
    )
    const offline = client(new Error('socket hang up'))
    await expect(resolveCreateRepoSelector({ client: offline, ...base })).rejects.toThrow(
      'socket hang up'
    )
  })

  it('surfaces the folder explanation when there is no cwd repo either', async () => {
    const c = client({
      resolution: { kind: 'error', code: 'none-attached', message: 'Ops has no attached repo yet.' }
    })
    await expect(
      resolveCreateRepoSelector({ client: c, ...base, cwdParentWorktree: undefined })
    ).rejects.toThrow('Ops has no attached repo yet.')
  })
})
