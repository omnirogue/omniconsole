import { describe, expect, it, vi } from 'vitest'
import type { SessionFolderRelayRequest } from '../../shared/session-folder-cli'
import {
  bindProjectLaunchContext,
  PROJECT_FOR_PANE_OLDER_WINDOW,
  readProjectForPane
} from './project-for-pane'

const relay = (answer: (request: SessionFolderRelayRequest) => unknown) => {
  const requestSessionFolders = vi.fn(async (request: SessionFolderRelayRequest) => answer(request))
  return { requestSessionFolders }
}

describe('readProjectForPane', () => {
  it('answers the project folder the window counts the pane in, or null', async () => {
    const runtime = relay(() => ({ folderId: 'project-1' }))
    await expect(readProjectForPane(runtime, 'tab-1:leaf-1')).resolves.toBe('project-1')
    expect(runtime.requestSessionFolders).toHaveBeenCalledWith({
      kind: 'projectForPane',
      paneKey: 'tab-1:leaf-1'
    })
    await expect(
      readProjectForPane(
        relay(() => ({ folderId: null })),
        'p'
      )
    ).resolves.toBeNull()
  })

  it('refuses an older window, which answers a kind it does not know with nothing', async () => {
    await expect(
      readProjectForPane(
        relay(() => undefined),
        'p'
      )
    ).rejects.toThrow(PROJECT_FOR_PANE_OLDER_WINDOW)
  })
})

describe('bindProjectLaunchContext', () => {
  const items = [{ id: 'slite:1', kind: 'slite' as const, title: 'Plan', content: 'Plan' }]

  it('keeps the items on the tab through the window', async () => {
    const runtime = relay(() => ({ bound: true }))
    await expect(
      bindProjectLaunchContext(runtime, { tabId: 'tab-1', worktreeId: 'repo::/w', items })
    ).resolves.toBe(true)
    expect(runtime.requestSessionFolders).toHaveBeenCalledWith({
      kind: 'bindLaunchContext',
      tabId: 'tab-1',
      worktreeId: 'repo::/w',
      items
    })
  })

  it('says so when no window, or an older one, could keep them', async () => {
    const closed = relay(() => {
      throw new Error('no window')
    })
    await expect(
      bindProjectLaunchContext(closed, { tabId: 't', worktreeId: null, items })
    ).resolves.toBe(false)
    await expect(
      bindProjectLaunchContext(
        relay(() => undefined),
        { tabId: 't', worktreeId: null, items }
      )
    ).resolves.toBe(false)
  })

  it('asks nothing when there is nothing to keep', async () => {
    const runtime = relay(() => ({ bound: true }))
    await expect(
      bindProjectLaunchContext(runtime, { tabId: 't', worktreeId: null, items: [] })
    ).resolves.toBe(true)
    expect(runtime.requestSessionFolders).not.toHaveBeenCalled()
  })
})
