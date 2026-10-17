import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspaceAttachedReposById } from '../../../../shared/folder-workspace-attached-repos'

const env = vi.hoisted(() => ({ runtime: vi.fn(), ownerEnvironment: null as string | null }))

vi.mock('../../runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => env.runtime(...args),
  getActiveRuntimeTarget: ({
    activeRuntimeEnvironmentId
  }: {
    activeRuntimeEnvironmentId?: string | null
  }) =>
    activeRuntimeEnvironmentId
      ? { kind: 'environment', environmentId: activeRuntimeEnvironmentId }
      : { kind: 'local' }
}))
vi.mock('@/lib/folder-workspace-runtime-owner', () => ({
  getRuntimeEnvironmentIdForFolderWorkspace: () => env.ownerEnvironment
}))

import {
  createFolderWorkspaceAttachedRepoSlice,
  selectFolderWorkspaceAttachedRepos,
  selectFolderWorkspaceAttachedReposStatus
} from './folder-workspace-attached-repo-actions'

const row = (name: string) => [{ key: `local|${name}`, displayName: name }] as never

function makeSlice() {
  let state: Record<string, unknown> = {}
  const set = (partial: unknown) => {
    const next =
      typeof partial === 'function' ? (partial as (s: unknown) => unknown)(state) : partial
    state = { ...state, ...(next as object) }
  }
  const slice = createFolderWorkspaceAttachedRepoSlice(set as never, (() => state) as never)
  state = { ...slice }
  return {
    slice,
    read: (id: string) => selectFolderWorkspaceAttachedRepos(state as never, id),
    status: (id: string) => selectFolderWorkspaceAttachedReposStatus(state as never, id)
  }
}

let api: {
  folderWorkspaces: Record<string, ReturnType<typeof vi.fn>>
  runtimeEnvironments: { list: ReturnType<typeof vi.fn> }
}
beforeEach(() => {
  env.runtime.mockReset()
  env.ownerEnvironment = null
  api = {
    folderWorkspaces: { listAttachedRepos: vi.fn(), attachRepo: vi.fn(), detachRepo: vi.fn() },
    runtimeEnvironments: { list: vi.fn(async () => []) }
  }
  ;(globalThis as { window?: unknown }).window = { api }
})
afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('folder attached repo cache (reviews F2, N2, N3, N5, R2)', () => {
  it('ignores an older read that resolves after a newer one', async () => {
    let releaseOld: (value: FolderWorkspaceAttachedReposById) => void = () => {}
    api.folderWorkspaces.listAttachedRepos
      .mockImplementationOnce(() => new Promise((resolve) => (releaseOld = resolve)))
      .mockImplementationOnce(async () => ({ ops: row('new') }))
    const { slice, read } = makeSlice()
    const older = slice.refreshFolderWorkspaceAttachedRepos()
    await slice.refreshFolderWorkspaceAttachedRepos()
    releaseOld({ ops: row('old') })
    await older
    expect(read('ops')).toEqual(row('new'))
  })

  it('keeps a same-id folder on another host apart from the local one', async () => {
    api.runtimeEnvironments.list.mockResolvedValue([{ id: 'a' }])
    api.folderWorkspaces.listAttachedRepos.mockResolvedValue({ ops: row('local') })
    env.runtime.mockResolvedValue({ attachedRepos: { ops: row('remote') } })
    const { slice, read } = makeSlice()
    await slice.refreshFolderWorkspaceAttachedRepos()
    expect(read('ops')).toEqual(row('local'))
    env.ownerEnvironment = 'a'
    expect(read('ops')).toEqual(row('remote'))
  })

  it('keeps a completed attach when a later read fails, and keeps hosts when listing fails', async () => {
    api.folderWorkspaces.listAttachedRepos.mockResolvedValueOnce({ ops: row('before') })
    const { slice, read } = makeSlice()
    await slice.refreshFolderWorkspaceAttachedRepos()
    api.folderWorkspaces.attachRepo.mockResolvedValueOnce(row('attached'))
    await slice.attachFolderWorkspaceRepo({ folderWorkspaceId: 'ops', repoId: 'r' })
    api.folderWorkspaces.listAttachedRepos.mockRejectedValueOnce(new Error('ipc down'))
    api.runtimeEnvironments.list.mockRejectedValueOnce(new Error('offline'))
    await slice.refreshFolderWorkspaceAttachedRepos()
    expect(read('ops')).toEqual(row('attached'))
  })
})

describe('folder attached repo cache (PR3 round 2: N1, N2, N3, F3)', () => {
  it('lands an attach reply on the host that was asked, even after the view moved (N1)', async () => {
    api.runtimeEnvironments.list.mockResolvedValue([{ id: 'a' }])
    api.folderWorkspaces.listAttachedRepos.mockResolvedValue({ ops: row('local-before') })
    env.runtime.mockResolvedValue({ attachedRepos: { ops: row('remote') } })
    const { slice, read } = makeSlice()
    await slice.refreshFolderWorkspaceAttachedRepos()
    let release: (value: unknown) => void = () => {}
    api.folderWorkspaces.attachRepo.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve))
    )
    const attaching = slice.attachFolderWorkspaceRepo({ folderWorkspaceId: 'ops', repoId: 'r' })
    env.ownerEnvironment = 'a'
    release(row('local-after'))
    await attaching
    expect(read('ops')).toEqual(row('remote'))
    env.ownerEnvironment = null
    expect(read('ops')).toEqual(row('local-after'))
  })

  it('filters a detach on the host that was asked (N1)', async () => {
    api.runtimeEnvironments.list.mockResolvedValue([{ id: 'a' }])
    api.folderWorkspaces.listAttachedRepos.mockResolvedValue({
      ops: [...row('keep'), { key: 'gone', displayName: 'gone' }]
    })
    env.runtime.mockResolvedValue({ attachedRepos: { ops: row('remote') } })
    const { slice, read } = makeSlice()
    await slice.refreshFolderWorkspaceAttachedRepos()
    let release: (value: boolean) => void = () => {}
    api.folderWorkspaces.detachRepo.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve))
    )
    const detaching = slice.detachFolderWorkspaceRepo('ops', 'gone')
    env.ownerEnvironment = 'a'
    release(true)
    await detaching
    expect(read('ops')).toEqual(row('remote'))
    env.ownerEnvironment = null
    expect(read('ops')).toEqual(row('keep'))
  })

  it('never lets an older host enumeration prune a host a newer refresh loaded (N2)', async () => {
    let releaseOld: (value: { id: string }[]) => void = () => {}
    api.runtimeEnvironments.list
      .mockImplementationOnce(() => new Promise((resolve) => (releaseOld = resolve)))
      .mockResolvedValueOnce([{ id: 'b' }])
    api.folderWorkspaces.listAttachedRepos.mockResolvedValue({})
    env.runtime.mockResolvedValue({ attachedRepos: { ops: row('b') } })
    const { slice, read } = makeSlice()
    const older = slice.refreshFolderWorkspaceAttachedRepos()
    await slice.refreshFolderWorkspaceAttachedRepos()
    releaseOld([])
    await older
    env.ownerEnvironment = 'b'
    expect(read('ops')).toEqual(row('b'))
  })

  it('does not list paired runtimes for a local-only first-paint load', async () => {
    api.folderWorkspaces.listAttachedRepos.mockResolvedValue({ ops: row('local') })
    const { slice, read } = makeSlice()
    await slice.refreshFolderWorkspaceAttachedRepos({ remoteHosts: 'skip' })
    expect(api.runtimeEnvironments.list).not.toHaveBeenCalled()
    expect(env.runtime).not.toHaveBeenCalled()
    expect(read('ops')).toEqual(row('local'))
  })

  it('reports loading, then failed, then ready instead of an empty list (F3)', async () => {
    const { slice, status } = makeSlice()
    expect(status('ops')).toBe('loading')
    api.folderWorkspaces.listAttachedRepos.mockRejectedValueOnce(new Error('timeout'))
    await slice.refreshFolderWorkspaceAttachedRepos()
    expect(status('ops')).toBe('failed')
    api.folderWorkspaces.listAttachedRepos.mockResolvedValueOnce({})
    await slice.refreshFolderWorkspaceAttachedRepos()
    expect(status('ops')).toBe('ready')
  })

  it('treats a detection reply without candidates as incomplete (N3)', async () => {
    env.ownerEnvironment = 'a'
    env.runtime.mockResolvedValueOnce({ incomplete: false })
    const { slice } = makeSlice()
    await expect(slice.detectFolderWorkspaceRepos('ops')).resolves.toEqual({
      candidates: [],
      incomplete: true
    })
  })
})
