import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  tabsByWorktree: {} as Record<string, unknown[]>,
  localWorkflowStatusByTabId: {} as Record<string, unknown>,
  localWorkflowHydrationByTabId: {} as Record<string, unknown>,
  buildReview: { pipelinesById: {}, pipelinesListed: false }
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
const bulk = vi.hoisted(() => ({
  closeSessionTabForBulk: vi.fn(async () => 'closed' as const),
  deleteKeepsPtyIds: vi.fn((): string[] => [])
}))
vi.mock('@/components/sidebar/session-folders/session-bulk-delete', () => ({
  isSessionTabWorking: () => false,
  closeSessionTabForBulk: bulk.closeSessionTabForBulk,
  deleteKeepsPtyIds: bulk.deleteKeepsPtyIds
}))

const { closeDeletedTab, refuseWorkingDelete } = await import('./session-folder-delete-tab')

describe('closeDeletedTab', () => {
  it('keeps a Recently closed entry for an ordinary delete, none for a purge', async () => {
    expect((await closeDeletedTab('tab-1')).summary).toContain('Recently closed')
    expect(bulk.closeSessionTabForBulk).toHaveBeenLastCalledWith('tab-1', {
      captureRecentlyClosed: true,
      endProcess: true
    })
    expect((await closeDeletedTab('tab-1', { purge: true })).summary).toContain('for good')
    expect(bulk.closeSessionTabForBulk).toHaveBeenLastCalledWith('tab-1', {
      captureRecentlyClosed: false,
      endProcess: true
    })
  })

  it('says the terminal stays when another live tab here still shows it', async () => {
    bulk.deleteKeepsPtyIds.mockReturnValueOnce(['local-repo::/tmp/app@@9369dd50'])

    expect((await closeDeletedTab('tab-1')).summary).toContain(
      'its terminal stays open because another tab here still shows it'
    )
  })

  it('removes the row only, and says so, for a session this computer could not verify', async () => {
    bulk.deleteKeepsPtyIds.mockClear()
    const closed = await closeDeletedTab('tab-1', { unverified: true })

    expect(closed.summary).toContain('no terminal was ended')
    expect(bulk.closeSessionTabForBulk).toHaveBeenLastCalledWith('tab-1', {
      captureRecentlyClosed: true,
      endProcess: false
    })
    expect(bulk.deleteKeepsPtyIds).not.toHaveBeenCalled()
  })
})

function workflowTab(id: string, localWorkflow: Record<string, unknown>) {
  return { id, worktreeId: 'w', ptyId: null, title: 'Discover', localWorkflow }
}

describe('refuseWorkingDelete: workflow tabs', () => {
  it('refuses a workflow that is still running unless --force', () => {
    state.tabsByWorktree = {
      w: [
        workflowTab('tab-run', {
          preset: 'discover',
          prompt: 'p',
          startRequest: { requestId: 'r', draft: {} }
        })
      ]
    }
    const session = { key: 'k', label: 'Discover', tabId: 'tab-run' }
    expect(() => refuseWorkingDelete(session, false)).toThrow('a workflow that is still running')
    expect(() => refuseWorkingDelete(session, true)).not.toThrow()
  })

  it('lets a leftover workflow tab go when its state never arrived', () => {
    state.tabsByWorktree = {
      w: [workflowTab('tab-old', { preset: 'discover', prompt: 'p', executionId: 'e-1' })]
    }
    expect(() =>
      refuseWorkingDelete({ key: 'k', label: 'Discover', tabId: 'tab-old' }, false)
    ).not.toThrow()
  })
})
