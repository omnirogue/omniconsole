// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { FolderWorkspaceRepoCandidate } from '../../../../shared/folder-workspace-repo-candidates'

const state = vi.hoisted(() => ({
  store: {} as Record<string, unknown>
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(state.store),
    { getState: () => state.store }
  )
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => values?.[name] ?? '')
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/folder-workspace-runtime-owner', () => ({
  getRuntimeEnvironmentIdForFolderWorkspace: () => 'runtime-a'
}))

import { FolderWorkspaceAttachedRepos } from './FolderWorkspaceAttachedRepos'

const folder = { id: 'ops', name: 'Ops', folderPath: '/work/ops' } as FolderWorkspace
let root: Root | null = null
let host: HTMLDivElement

async function render(
  candidates: FolderWorkspaceRepoCandidate[],
  detect?: () => Promise<{ candidates: FolderWorkspaceRepoCandidate[]; incomplete: boolean }>
) {
  state.store.detectFolderWorkspaceRepos = vi.fn(
    detect ?? (async () => ({ candidates, incomplete: false }))
  )
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<FolderWorkspaceAttachedRepos folderWorkspace={folder} />)
  })
}

beforeEach(() => {
  state.store = {
    folderWorkspaceAttachedReposBySource: { 'runtime:runtime-a': {} },
    folderWorkspaceAttachedRepoFailedSources: {},
    attachFolderWorkspaceRepo: vi.fn(async () => true),
    detachFolderWorkspaceRepo: vi.fn(async () => true),
    addRepoPath: vi.fn(async () => ({ id: 'new-repo' })),
    refreshFolderWorkspaceAttachedRepos: vi.fn(async () => {})
  }
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
})

describe('FolderWorkspaceAttachedRepos', () => {
  it('offers a detected checkout and attaches it with one click', async () => {
    await render([
      {
        path: '/work/ops/site',
        displayName: 'site',
        connectionId: null,
        registeredRepoId: 'repo-site',
        attached: false
      }
    ])
    expect(host.textContent).toContain('Attach site?')
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Attach')!
    await act(async () => button.click())
    expect(state.store.attachFolderWorkspaceRepo).toHaveBeenCalledWith({
      folderWorkspaceId: 'ops',
      repoId: 'repo-site',
      source: 'detected-checkout'
    })
  })

  it('adds an unregistered local checkout as a project before attaching it', async () => {
    await render([
      {
        path: '/work/ops/new',
        displayName: 'new',
        connectionId: null,
        registeredRepoId: null,
        attached: false
      }
    ])
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Attach')!
    await act(async () => button.click())
    // Why the owner option: registration goes to the folder's host, not the focused runtime.
    expect(state.store.addRepoPath).toHaveBeenCalledWith('/work/ops/new', 'git', {
      runtimeEnvironmentId: 'runtime-a'
    })
    expect(state.store.attachFolderWorkspaceRepo).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'new-repo' })
    )
  })

  it('cannot attach an unregistered remote checkout, and says why', async () => {
    await render([
      {
        path: '/srv/app',
        displayName: 'app',
        connectionId: 'ssh-1',
        registeredRepoId: null,
        attached: false
      }
    ])
    expect(host.textContent).toContain('Add this checkout as a project on its host first.')
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Attach')!
    expect(button.disabled).toBe(true)
  })

  it('shows how repos attach when nothing is attached or found', async () => {
    await render([])
    expect(host.textContent).toContain('No repo attached yet.')
  })

  it('says when the search stopped early or failed instead of showing an empty folder', async () => {
    await render([], async () => ({ candidates: [], incomplete: true }))
    expect(host.textContent).toContain('some checkouts in this folder may not be listed')
    act(() => root?.unmount())
    host.remove()
    await render([], async () => {
      throw new Error('ssh_connection_unavailable')
    })
    expect(host.textContent).toContain(
      'Could not look for repos in this folder: ssh_connection_unavailable'
    )
    expect(host.textContent).not.toContain('No repo attached yet.')
  })

  it('reports a failed detach and reloads the list', async () => {
    const { toast } = await import('sonner')
    state.store.folderWorkspaceAttachedReposBySource = {
      'runtime:runtime-a': {
        ops: [{ key: 'local|x', displayName: 'site', repoPath: '/work/ops/site' }]
      }
    }
    state.store.detachFolderWorkspaceRepo = vi.fn(async () => {
      throw new Error('offline')
    })
    await render([])
    const button = host.querySelector('button[aria-label="Detach site"]') as HTMLButtonElement
    await act(async () => button.click())
    expect(toast.error).toHaveBeenCalledWith('Could not detach site.')
    expect(state.store.refreshFolderWorkspaceAttachedRepos).toHaveBeenCalled()
  })

  it('does not call a failed attachment load "no repo attached" (review F3)', async () => {
    state.store.folderWorkspaceAttachedReposBySource = {}
    state.store.folderWorkspaceAttachedRepoFailedSources = { 'runtime:runtime-a': true }
    await render([])
    expect(host.textContent).toContain("Could not load this folder's attached repos.")
    expect(host.textContent).not.toContain('No repo attached yet.')
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Try again')
    await act(async () => retry!.click())
    expect(state.store.refreshFolderWorkspaceAttachedRepos).toHaveBeenCalled()
  })
})
