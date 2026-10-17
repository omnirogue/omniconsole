import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlannedItem, SessionPrepSteps } from '../../shared/session-prep-types'
import type { SessionProjectLaunch } from '../../shared/session-project-cli'
import type { SessionPrepHost } from './session-prep-host'
import { SessionPrepService } from './session-prep-service'
import { SessionPrepStore } from './session-prep-store'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function dispatch(options: {
  folders?: (string | undefined)[]
  missing?: boolean
  remote?: boolean
}) {
  const directory = await mkdtemp(join(tmpdir(), 'omni-project-dispatch-'))
  directories.push(directory)
  const store = new SessionPrepStore(directory)
  const execution = options.remote
    ? { isRemote: true, connectionId: 'box', hostId: 'ssh:box' }
    : { isRemote: false, hostId: 'local' }
  const workspace = { path: '/work', repoId: 'folder:work', isFolder: true, ...execution }
  const existing = { id: 'project-id', path: 'Company / Project' }
  const projectLaunch = vi.fn(
    async ({ folder }: { folder: string }) =>
      ({
        project: { folderId: folder, name: 'Project' },
        host: { id: execution.hostId, label: execution.hostId },
        projectLine: 'Project: Project',
        attachments: [],
        inherited: [],
        notOnHost: [],
        agent: null,
        error: null
      }) satisfies SessionProjectLaunch
  )
  const createAgentSessionIn = vi.fn(async () => ({ tabId: 'new-tab', paneKey: 'new-pane' }))
  const fileSession = vi.fn(async ({ folder }: Parameters<SessionPrepHost['fileSession']>[0]) => ({
    path: typeof folder === 'string' ? folder : folder.path
  }))
  const resolveExistingFolder = vi.fn(async () => {
    if (options.missing) {
      throw new Error('The project folder no longer exists.')
    }
    return existing
  })
  const host: SessionPrepHost = {
    resolveWorktree: async () => workspace,
    listRepos: () => [],
    resolveRepo: () => null,
    createWorktreeWithAgent: vi.fn(),
    createAgentSessionIn,
    fileSession,
    resolveExistingFolder,
    createBatchFolder: vi.fn(),
    worktreeExistsByName: async () => false,
    findWorktreeIdByName: async () => null,
    isAgentEnabled: () => true,
    projectLaunch
  }
  const items = (options.folders ?? [undefined, undefined]).map((folder, index): PlannedItem => ({
    title: `Task ${index}`,
    ask: `Do task ${index}`,
    anchor: `task ${index}`,
    direct: true,
    changesCode: false,
    ...(folder ? { choices: { folder } } : {})
  }))
  const steps: SessionPrepSteps = {
    plan: async () => ({ items, dropped: [] }),
    prepare: vi.fn(),
    revise: vi.fn(),
    gate: vi.fn(),
    render: vi.fn(),
    renderDirect: ({ item }) => item.ask
  }
  const service = new SessionPrepService({ host, store, steps: () => steps })
  await service.start()
  const { batchId } = service.request({
    text: 'Launch sessions for task zero and task one',
    source: { worktreeId: 'folder:work', paneKey: 'source-pane', agent: 'claude' },
    context: '',
    defaultFolder: 'project-id'
  })
  await vi.waitFor(() => expect(service.get(batchId).state).toBe('done'), { timeout: 20_000 })
  await store.persist()
  const restored = new SessionPrepStore(directory)
  await restored.load()
  return { host, batch: restored.get(batchId)!, view: service.get(batchId) }
}

describe('session prep default project', () => {
  it('persists the source project and inherits and files every unnamed item there', async () => {
    const { host, batch, view } = await dispatch({})
    expect(batch.defaultFolder).toBe('project-id')
    expect(host.createBatchFolder).not.toHaveBeenCalled()
    expect(host.projectLaunch).toHaveBeenCalledWith({
      folder: 'project-id',
      host: 'local',
      worktreeId: 'folder:work'
    })
    expect(host.createAgentSessionIn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Project: Project')
      })
    )
    expect(host.fileSession).toHaveBeenCalledTimes(2)
    expect(host.fileSession).toHaveBeenCalledWith(
      expect.objectContaining({
        folder: { id: 'project-id', path: 'Company / Project' }
      })
    )
    expect(view.items.map((item) => item.folder)).toEqual([
      'Company / Project',
      'Company / Project'
    ])
  })

  it('honors an explicit per-item folder over the inherited project', async () => {
    const { host } = await dispatch({ folders: ['Another / Project'] })
    expect(host.resolveExistingFolder).not.toHaveBeenCalled()
    expect(host.projectLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'Another / Project' })
    )
    expect(host.fileSession).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'Another / Project' })
    )
  })

  it('reports a removed project without substituting or creating a folder', async () => {
    const { host, view } = await dispatch({ missing: true })
    expect(host.createBatchFolder).not.toHaveBeenCalled()
    expect(host.projectLaunch).not.toHaveBeenCalled()
    expect(host.fileSession).not.toHaveBeenCalled()
    expect(
      view.items.every(
        (item) => item.state === 'launched' && item.note?.includes('no longer exists')
      )
    ).toBe(true)
  })

  it('resolves context for the SSH owner while filing through the controller', async () => {
    const { host } = await dispatch({ remote: true, folders: [undefined] })
    expect(host.projectLaunch).toHaveBeenCalledWith({
      folder: 'project-id',
      host: 'ssh:box',
      worktreeId: 'folder:work'
    })
    expect(host.createAgentSessionIn).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedWorkspace: expect.objectContaining({ connectionId: 'box', hostId: 'ssh:box' })
      })
    )
  })
})
