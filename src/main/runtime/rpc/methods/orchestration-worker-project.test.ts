import { describe, expect, it, vi } from 'vitest'
import { emptyProjectSettings } from '../../../../shared/project-settings'
import {
  SESSION_FOLDERS_NO_WINDOW_ERROR,
  type SessionFolderRelayRequest
} from '../../../../shared/session-folder-cli'
import type { SessionProjectReadResult } from '../../../../shared/session-project-cli'
import {
  findWorkerProject,
  inheritRemoteWorkerProject,
  inheritWorkerProject,
  type WorkerProjectRuntime
} from './orchestration-worker-project'

const PROJECT = 'project-1'
const read = (folderId = PROJECT, settings = true): SessionProjectReadResult => ({
  folder: { id: folderId, name: 'Ads', path: 'Ads' },
  project: {
    folderId: PROJECT,
    name: 'Ads',
    path: 'Ads',
    settings: settings
      ? {
          ...emptyProjectSettings(1),
          agents: [
            {
              templateId: 'coordinator',
              name: 'Coordinator',
              digest: 'a'.repeat(12),
              instructions: 'Only coordinate; never do the work.'
            }
          ],
          attachments: [
            { id: 'instructions', kind: 'instructions', title: 'Rules', content: 'Ship small' },
            {
              id: 'instructions-copy',
              kind: 'instructions',
              title: 'Rules copy',
              content: 'Ship small'
            },
            { id: 'file:local:/a.md', kind: 'file', title: 'a.md', uri: '/a.md', hostId: 'local' }
          ]
        }
      : null
  }
})

function runtime(
  options: {
    launcherProject?: string | null
    window?: boolean
    readProject?: (folder: string) => SessionProjectReadResult
    executionHostId?: string
  } = {}
) {
  const requests: SessionFolderRelayRequest[] = []
  const filed: SessionFolderRelayRequest[] = []
  const answer = async (request: SessionFolderRelayRequest) => {
    requests.push(request)
    if (options.window === false) {
      throw new Error(SESSION_FOLDERS_NO_WINDOW_ERROR)
    }
    if (request.kind === 'projectForPane') {
      return { folderId: options.launcherProject ?? null }
    }
    if (request.kind === 'readProject') {
      return (options.readProject ?? (() => read()))(request.folder)
    }
    if (request.kind === 'bindLaunchContext') {
      return { bound: true }
    }
    throw new Error(`unexpected ${request.kind}`)
  }
  const value: WorkerProjectRuntime = {
    requestSessionFolders: vi.fn(answer),
    listRepos: () => [],
    listProjects: () => [],
    listProjectHostSetups: () => [],
    listFolderWorkspaceAttachedRepos: () => ({}),
    getTerminalPaneKey: (handle) => `${handle}-tab:leaf`,
    showTerminal: async () => ({
      tabId: 'worker-tab',
      worktreeId: 'repo::/w',
      executionHostId: (options.executionHostId ?? 'ssh:box') as never
    }),
    filing: vi.fn(async (request: SessionFolderRelayRequest) => {
      filed.push(request)
      return { summary: 'Filed', sessionKey: 'key-1' }
    })
  }
  return { value, requests, filed }
}

const from = { from: 'term_coord' }

describe('findWorkerProject', () => {
  it("joins the coordinator's project and leaves the worker to nest under it", async () => {
    const { value, requests } = runtime({ launcherProject: PROJECT })
    await expect(findWorkerProject(value, from)).resolves.toEqual({
      kind: 'project',
      folder: PROJECT,
      fileInto: false
    })
    expect(requests).toEqual([{ kind: 'projectForPane', paneKey: 'term_coord-tab:leaf' }])
  })

  it('joins nothing for a coordinator in no project, or with --no-project', async () => {
    await expect(findWorkerProject(runtime().value, from)).resolves.toEqual({ kind: 'none' })
    const opted = runtime({ launcherProject: PROJECT })
    await expect(findWorkerProject(opted.value, { ...from, noProject: true })).resolves.toEqual({
      kind: 'none'
    })
    expect(opted.requests).toEqual([])
  })

  it('files a worker sent in from outside with --project, but not one whose launcher is in it', async () => {
    await expect(
      findWorkerProject(runtime().value, { ...from, project: 'Ads / Research' })
    ).resolves.toEqual({ kind: 'project', folder: PROJECT, fileInto: true })
    await expect(
      findWorkerProject(runtime({ launcherProject: PROJECT }).value, { ...from, project: 'Ads' })
    ).resolves.toEqual({ kind: 'project', folder: PROJECT, fileInto: false })
  })

  it('refuses a --project folder that is in no project or does not exist, before any effect', async () => {
    const plain = runtime({ readProject: () => ({ ...read(), project: null }) })
    await expect(
      findWorkerProject(plain.value, { ...from, project: 'Misc' })
    ).rejects.toMatchObject({
      code: 'project_not_found',
      message: expect.stringContaining('is not in a project')
    })
    const missing = runtime({
      readProject: (folder) => {
        throw new Error(`No folder matches “${folder}”.`)
      }
    })
    await expect(
      findWorkerProject(missing.value, { ...from, project: 'Nope' })
    ).rejects.toMatchObject({
      code: 'project_not_found',
      message: '--project Nope: No folder matches “Nope”.'
    })
    await expect(
      findWorkerProject(runtime().value, { ...from, project: 'Ads', noProject: true })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('starts the worker without its project when no window can answer, and says why', async () => {
    const closed = runtime({ window: false })
    await expect(findWorkerProject(closed.value, from)).resolves.toEqual({
      kind: 'unread',
      reason: SESSION_FOLDERS_NO_WINDOW_ERROR
    })
    await expect(findWorkerProject(closed.value, { ...from, project: 'Ads' })).resolves.toEqual({
      kind: 'unread',
      reason: SESSION_FOLDERS_NO_WINDOW_ERROR
    })
  })
})

describe('inheritWorkerProject', () => {
  const plan = { kind: 'project' as const, folder: PROJECT, fileInto: false }

  it('briefs the worker with the project resolved for its host, keeping the context on its tab', async () => {
    const { value, requests, filed } = runtime()
    const inherited = await inheritWorkerProject(value, plan, {
      terminalHandle: 'term_worker',
      created: true
    })
    expect(inherited.brief).toContain('Project: Ads')
    expect(inherited.brief).toContain('Ship small')
    expect(inherited.brief).toContain('omni folder project --folder project-1')
    expect(inherited.brief).toContain('Project agents you may use as subagents: Coordinator')
    expect(inherited.brief).not.toContain('Only coordinate; never do the work.')
    expect(inherited.brief?.match(/Ship small/g)).toHaveLength(1)
    expect(inherited.brief).not.toContain('/a.md')
    expect(inherited.receipt).toEqual({
      project: { folderId: PROJECT, name: 'Ads', notOnHost: ['a.md'] }
    })
    expect(requests.at(-1)).toMatchObject({
      kind: 'bindLaunchContext',
      tabId: 'worker-tab',
      worktreeId: 'repo::/w',
      items: [expect.objectContaining({ id: 'instructions' })]
    })
    expect(filed).toEqual([])
  })

  it('files a worker sent in from outside into the folder --project named', async () => {
    const { value, filed } = runtime()
    const inherited = await inheritWorkerProject(
      value,
      { ...plan, fileInto: true },
      { terminalHandle: 'term_worker', created: true }
    )
    expect(filed).toEqual([
      {
        kind: 'mutate',
        op: {
          kind: 'moveSession',
          paneKey: 'term_worker-tab:leaf',
          tabId: 'worker-tab',
          destination: 'folder',
          folder: PROJECT,
          waitMs: 5_000
        }
      }
    ])
    expect(inherited.receipt.project).toMatchObject({ filed: true })
  })

  it('leaves a reused terminal where it is, still briefed', async () => {
    const { value, requests, filed } = runtime()
    const inherited = await inheritWorkerProject(
      value,
      { ...plan, fileInto: true },
      { terminalHandle: 'term_worker', created: false }
    )
    expect(inherited.brief).toContain('Project: Ads')
    expect(requests.some((request) => request.kind === 'bindLaunchContext')).toBe(false)
    expect(filed).toEqual([])
    expect(inherited.receipt.project).not.toHaveProperty('filed')
  })

  it('reports why nothing was inherited instead of failing the start', async () => {
    const unread = await inheritWorkerProject(
      runtime().value,
      { kind: 'unread', reason: 'no window' },
      { terminalHandle: 't', created: true }
    )
    expect(unread).toEqual({ receipt: { project: { notInherited: 'no window' } } })
    const hostless = await inheritWorkerProject(runtime({ executionHostId: '' }).value, plan, {
      terminalHandle: 't',
      created: true
    })
    expect(hostless.brief).toBeUndefined()
    expect(hostless.receipt.project).toEqual({
      notInherited: 'OmniConsole could not tell which computer the worker runs on.'
    })
    await expect(
      inheritWorkerProject(
        runtime().value,
        { kind: 'none' },
        { terminalHandle: 't', created: true }
      )
    ).resolves.toEqual({ receipt: {} })
  })
})

describe('inheritRemoteWorkerProject', () => {
  const plan = { kind: 'project' as const, folder: PROJECT, fileInto: false }
  const studio = { hostId: 'runtime:env-studio', name: 'Studio' }

  it('briefs a worker on another computer for that computer, and keeps nothing on a tab here', async () => {
    const { value, requests, filed } = runtime()
    const inherited = await inheritRemoteWorkerProject(value, plan, studio)
    expect(inherited.brief).toContain('Project: Ads')
    expect(inherited.brief).toContain('Ship small')
    expect(inherited.brief?.match(/Ship small/g)).toHaveLength(1)
    expect(inherited.brief).not.toContain('Only coordinate; never do the work.')
    expect(inherited.brief).not.toContain('/a.md')
    expect(inherited.receipt).toEqual({
      project: { folderId: PROJECT, name: 'Ads', notOnHost: ['a.md'] }
    })
    expect(requests).toEqual([{ kind: 'readProject', folder: PROJECT }])
    expect(filed).toEqual([])
  })

  it('says a worker sent in from outside is not filed, since it runs on the other computer', async () => {
    const inherited = await inheritRemoteWorkerProject(
      runtime().value,
      { ...plan, fileInto: true },
      studio
    )
    expect(inherited.receipt.project).toMatchObject({
      notes: ['Not filed in the project: it runs on Studio.']
    })
    await expect(
      inheritRemoteWorkerProject(runtime().value, { kind: 'unread', reason: 'no window' }, studio)
    ).resolves.toEqual({ receipt: { project: { notInherited: 'no window' } } })
  })
})
