import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionPrepSteps } from '../../shared/session-prep-types'
import type { SessionPrepHost } from './session-prep-host'
import { SessionPrepService } from './session-prep-service'
import { SessionPrepStore } from './session-prep-store'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const WORK = { path: '/Users/me/Work', repoId: 'work', isFolder: true, isRemote: false }

it('launches a terminal request from the default Work folder and keeps the note saying so', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prep-terminal-'))
  directories.push(directory)
  const createAgentSessionIn = vi.fn(async () => ({ tabId: 'tab', paneKey: 'new-pane' }))
  const host = {
    resolveWorktree: async (id: string) => {
      if (id !== 'folder:work') {
        throw new Error('That workspace is not available for session prep.')
      }
      return WORK
    },
    defaultSourceWorktreeId: () => 'folder:work',
    listRepos: () => [],
    resolveRepo: () => null,
    createWorktreeWithAgent: vi.fn(),
    createAgentSessionIn,
    worktreeExistsByName: async () => false,
    findWorktreeIdByName: async () => null,
    isAgentEnabled: () => true,
    fileSession: async () => ({ path: 'Launch' }),
    createBatchFolder: async () => ({ id: 'batch-folder', path: 'Launch' })
  } as unknown as SessionPrepHost
  const steps = {
    plan: async () => ({
      items: [
        {
          title: 'Clean containers',
          ask: 'remove stale containers',
          anchor: 'remove stale containers',
          direct: true,
          changesCode: false
        }
      ],
      dropped: ['one ask was unclear']
    }),
    renderDirect: ({ item }: { item: { ask: string } }) => `DIRECT:${item.ask}`
  } as unknown as SessionPrepSteps
  const service = new SessionPrepService({
    host,
    steps: () => steps,
    store: new SessionPrepStore(directory)
  })
  await service.start()

  const result = await service.requestFromTerminal({
    text: 'launch a session to remove stale containers',
    source: { worktreeId: 'folder:gone', paneKey: 'pane-1', agent: 'claude' },
    context: ''
  })
  expect(result).toMatchObject({ outcome: 'started', startedIn: '/Users/me/Work' })

  let view = service.get(result.batchId)
  for (let attempt = 0; attempt < 2000 && !['done', 'failed'].includes(view.state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    view = service.get(result.batchId)
  }
  expect(view.state).toBe('done')
  expect(createAgentSessionIn).toHaveBeenCalledWith(
    expect.objectContaining({ worktreeId: 'folder:work' })
  )
  expect(view.notes).toEqual([
    expect.stringContaining('Started from /Users/me/Work'),
    'one ask was unclear'
  ])
})
