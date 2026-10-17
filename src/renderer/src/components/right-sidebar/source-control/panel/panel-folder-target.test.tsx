import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { FolderGitTarget } from '@/lib/folder-workspace-git-target'

const state = vi.hoisted(() => ({
  target: { kind: 'not-folder' } as FolderGitTarget,
  model: {} as Record<string, unknown>
}))

vi.mock('../listing/use-source-control-target', () => ({ useFolderGitTarget: () => state.target }))
vi.mock('./use-panel-model', () => ({ useSourceControlPanelModel: () => state.model }))
vi.mock('./panel-ready', () => ({
  SourceControlPanelReady: ({ currentWorktreeId }: { currentWorktreeId: string }) => (
    <div data-ready={currentWorktreeId} />
  )
}))
vi.mock('./folder-git-target', () => ({
  FolderGitTargetNeedsAttach: () => <div data-needs-attach />,
  FolderGitTargetAttachmentsUnknown: ({ failed }: { failed: boolean }) => (
    <div data-attachments-unknown={String(failed)} />
  ),
  FolderGitTargetPicker: () => <div data-picker />
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_k: string, fallback: string) => fallback }))

import { SourceControlPanel } from './panel'

const worktree = { id: 'repo-1::/work/newer' }
const readyModel = {
  activeRepo: { id: 'repo-1' },
  activeWorktree: worktree,
  isFolder: false,
  worktreePath: '/work/newer'
}

describe('SourceControlPanel in a folder workspace', () => {
  it('shows the attach state instead of "only for Git repositories"', () => {
    state.target = { kind: 'needs-attach', folderWorkspaceId: 'ops' }
    state.model = { activeRepo: null, activeWorktree: null, isFolder: false, worktreePath: null }
    const markup = renderToStaticMarkup(<SourceControlPanel />)
    expect(markup).toContain('data-needs-attach')
    expect(markup).not.toContain('only available for Git repositories')
  })

  it('shows the target picker above the attached repo worktree changes', () => {
    state.target = {
      kind: 'target',
      folderWorkspaceId: 'ops',
      worktree: worktree as never,
      candidates: []
    }
    state.model = readyModel
    const markup = renderToStaticMarkup(<SourceControlPanel />)
    expect(markup).toContain('data-picker')
    expect(markup).toContain(`data-ready="${worktree.id}"`)
  })

  it('renders an ordinary worktree without the picker', () => {
    state.target = { kind: 'not-folder' }
    state.model = readyModel
    const markup = renderToStaticMarkup(<SourceControlPanel />)
    expect(markup).not.toContain('data-picker')
    expect(markup).toContain('data-ready')
  })

  it('shows a failed attachment load instead of the attach state (round 2 F3)', () => {
    state.target = { kind: 'attachments-unknown', folderWorkspaceId: 'ops', failed: true }
    state.model = { activeRepo: null, activeWorktree: null, isFolder: false, worktreePath: null }
    const markup = renderToStaticMarkup(<SourceControlPanel />)
    expect(markup).toContain('data-attachments-unknown="true"')
    expect(markup).not.toContain('data-needs-attach')
  })
})
