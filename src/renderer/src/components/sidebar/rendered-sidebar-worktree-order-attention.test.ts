import { afterEach, describe, expect, it } from 'vitest'

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getVisibleWorktreeIds,
  setVisibleWorktreeIds,
  setVisibleWorktreeShortcutTargets
} from './visible-worktrees'
import { registerClosedSidebarAttentionReader } from './closed-sidebar-attention'

const initialState = useAppStore.getInitialState()

function wt(id: string, extra: Partial<Worktree> = {}): Worktree {
  return {
    id,
    repoId: 'repo1',
    path: `/tmp/${id}`,
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...extra
  } as Worktree
}

afterEach(() => {
  registerClosedSidebarAttentionReader(null)
  setVisibleWorktreeIds(null)
  setVisibleWorktreeShortcutTargets(null)
  useAppStore.setState(initialState, true)
})

describe('closed-sidebar order with run-request attention', () => {
  it('keeps a worktree with an open run request visible inside the folded group', () => {
    // Why a registered reader: run requests and reply decisions live in their own stores; this
    // pins that the closed-sidebar order reads the full attention set (review N1).
    registerClosedSidebarAttentionReader(() => new Set(['wt-run-request']))
    useAppStore.setState(
      {
        ...initialState,
        repos: [{ id: 'repo1', path: '/tmp/repo1', displayName: 'repo1' }],
        worktreesByRepo: {
          repo1: [wt('wt-main', { isMainWorktree: true }), wt('wt-run-request'), wt('wt-quiet')]
        },
        showSleepingWorkspaces: true,
        groupBy: 'repo',
        sortBy: 'manual',
        groupSessionWorktrees: true
      } as unknown as AppState,
      true
    )
    setVisibleWorktreeIds(null)
    expect(getVisibleWorktreeIds()).toEqual(['wt-main', 'wt-run-request'])
  })
})
