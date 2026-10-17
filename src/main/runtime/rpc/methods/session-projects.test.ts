import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionFolderRelayRequest } from '../../../../shared/session-folder-cli'
import type { SessionManageActor } from '../../../../shared/session-manage-types'
import {
  PROJECT_CREATE_REFUSED_AGENT,
  PROJECT_CREATE_REFUSED_CLI,
  SESSION_PROJECTS_RPC,
  type SessionProjectLaunch,
  type SessionProjectReadResult
} from '../../../../shared/session-project-cli'
import { emptyProjectSettings } from '../../../../shared/project-settings'
import type { Repo } from '../../../../shared/repo-types'
import type { RpcContext } from '../core'

const state = vi.hoisted(() => ({
  actor: { kind: 'cli' } as SessionManageActor,
  documents: new Map<string, string>()
}))
vi.mock('./session-manage-support', () => ({ actorFor: () => state.actor }))
vi.mock('../../../artifacts/context-document-search', () => ({
  resolveContextDocument: async ({ source, id }: { source: string; id: string }) => {
    const content = state.documents.get(`${source}:${id}`)
    return content === undefined
      ? { status: 'error', message: 'Slite is not connected.' }
      : {
          status: 'ok',
          document: {
            title: 'Ads plan (today)',
            url: 'https://slite.example/1',
            content,
            capturedAt: 7
          }
        }
  }
}))

const { SESSION_PROJECT_METHODS } = await import('./session-projects')
const method = (name: string) => SESSION_PROJECT_METHODS.find((entry) => entry.name === name)!

const FOLDER = '11111111-1111-4111-8111-111111111111'
const read: SessionProjectReadResult = {
  folder: { id: FOLDER, name: 'Ads', path: 'Ads' },
  project: {
    folderId: FOLDER,
    name: 'Ads',
    path: 'Ads',
    settings: {
      ...emptyProjectSettings(1),
      repos: [{ gitIdentity: 'github.com/omnirogue/omni-ide' }],
      attachments: [
        { id: 'slite:1', kind: 'slite', title: 'Ads plan', content: 'Plan' },
        {
          id: 'file:local:/Users/maintainer/brief.md',
          kind: 'file',
          title: 'brief.md',
          uri: '/Users/maintainer/brief.md',
          hostId: 'local'
        },
        { id: 'skill-name:jira', kind: 'skill', title: 'jira' }
      ]
    }
  }
}

function runtime(repos: Partial<Repo>[] = []) {
  const requests: SessionFolderRelayRequest[] = []
  const requestSessionFolders = vi.fn(async (request: SessionFolderRelayRequest) => {
    requests.push(request)
    return request.kind === 'readProject' ? read : { summary: 'shown' }
  })
  const value = {
    requestSessionFolders,
    listRepos: () => repos as Repo[],
    listProjects: () => [],
    listProjectHostSetups: () => [],
    listFolderWorkspaceAttachedRepos: () => ({}),
    resolveSkillDiscoveryProviderRoots: async () => ({})
  }
  return { requests, ctx: { runtime: value as unknown as RpcContext['runtime'] } as RpcContext }
}

beforeEach(() => {
  state.actor = { kind: 'cli' }
  state.documents.clear()
})

describe('sessionProjects.create', () => {
  it('refuses an agent session and names suggestion as its way', async () => {
    state.actor = { kind: 'pane', paneKey: 'tab-1:leaf-1', title: 'Fixer' }
    const { ctx, requests } = runtime()
    await expect(
      method(SESSION_PROJECTS_RPC.create).handler({ folder: FOLDER }, ctx)
    ).rejects.toThrow(PROJECT_CREATE_REFUSED_AGENT)
    expect(requests).toEqual([])
  })

  it('refuses the plain CLI too, which cannot prove a person', async () => {
    const { ctx, requests } = runtime()
    await expect(
      method(SESSION_PROJECTS_RPC.create).handler({ folder: FOLDER }, ctx)
    ).rejects.toThrow(PROJECT_CREATE_REFUSED_CLI)
    expect(requests).toEqual([])
  })

  it('refuses a paired device before anything else', async () => {
    const { ctx } = runtime()
    await expect(
      method(SESSION_PROJECTS_RPC.create).handler({ folder: FOLDER }, { ...ctx, clientId: 'phone' })
    ).rejects.toThrow(/Only the omni CLI on this computer/)
  })
})

describe('sessionProjects.suggest', () => {
  it('relays the suggestion to the window, naming the session that made it', async () => {
    state.actor = { kind: 'pane', paneKey: 'tab-1:leaf-1', title: 'Fixer' }
    const { ctx, requests } = runtime()
    await method(SESSION_PROJECTS_RPC.suggest).handler(
      { folder: 'Ads', reason: 'Same repos every time' },
      ctx
    )
    expect(requests).toEqual([
      {
        kind: 'suggestProject',
        folder: 'Ads',
        by: 'The session “Fixer”',
        reason: 'Same repos every time'
      }
    ])
  })
})

describe('sessionProjects.resolveLaunch', () => {
  it('lists what an SSH host lacks and resolves repos registered there', async () => {
    const { ctx } = runtime([
      {
        id: 'r1',
        path: '/home/sal/omni-ide',
        connectionId: 'box',
        executionHostId: 'ssh:box',
        gitRemoteIdentity: { canonicalKey: 'github.com/omnirogue/omni-ide' }
      } as unknown as Partial<Repo>
    ])
    const launch = (await method(SESSION_PROJECTS_RPC.resolveLaunch).handler(
      { folder: FOLDER, host: 'ssh:box' },
      ctx
    )) as SessionProjectLaunch
    expect(launch.projectLine).toBe('Project: Ads')
    expect(launch.attachments.map((item) => item.id)).toEqual([
      'repo:github.com/omnirogue/omni-ide',
      'slite:1',
      'skill-name:jira'
    ])
    expect(launch.attachments[0]).toMatchObject({ uri: '/home/sal/omni-ide', hostId: 'ssh:box' })
    expect(launch.notOnHost).toEqual([
      {
        id: 'file:local:/Users/maintainer/brief.md',
        kind: 'file',
        title: 'brief.md',
        hostId: 'local'
      }
    ])
    // Why unverified: skills.discover cannot read an SSH host's skills.
    expect(launch.inherited.find((item) => item.id === 'skill-name:jira')?.state).toBe('unverified')
  })
  it('re-reads Slite and OmniOS documents at launch, keeping the saved copy when a read fails', async () => {
    const { ctx } = runtime()
    const stale = (await method(SESSION_PROJECTS_RPC.resolveLaunch).handler(
      { folder: FOLDER, host: 'ssh:box' },
      ctx
    )) as SessionProjectLaunch
    expect(stale.attachments.find((item) => item.id === 'slite:1')?.content).toBe('Plan')
    expect(stale.notes).toEqual(['Kept the saved copy of “Ads plan”: Slite is not connected.'])

    state.documents.set('slite:1', 'Plan, as of today')
    const fresh = (await method(SESSION_PROJECTS_RPC.resolveLaunch).handler(
      { folder: FOLDER, host: 'ssh:box' },
      ctx
    )) as SessionProjectLaunch
    expect(fresh.attachments.find((item) => item.id === 'slite:1')).toMatchObject({
      title: 'Ads plan (today)',
      content: 'Plan, as of today',
      capturedAt: 7
    })
    expect(fresh).not.toHaveProperty('notes')
  })
})

describe('sessionProjects.bindLaunch', () => {
  const items = [{ id: 'slite:1', kind: 'slite' as const, title: 'Ads plan', content: 'Plan' }]

  function terminalRuntime(answer: unknown) {
    const { ctx, requests } = runtime()
    const showTerminal = vi.fn(async () => ({ tabId: 'tab-9', worktreeId: 'wt-1' }))
    Object.assign(ctx.runtime, {
      showTerminal,
      requestSessionFolders: async (request: SessionFolderRelayRequest) => {
        requests.push(request)
        return answer
      }
    })
    return { ctx, requests, showTerminal }
  }

  it("keeps a CLI launch's project context on the tab it started", async () => {
    const { ctx, requests, showTerminal } = terminalRuntime({ bound: true })
    await expect(
      method(SESSION_PROJECTS_RPC.bindLaunch).handler({ terminal: 'term_1', items }, ctx)
    ).resolves.toEqual({ bound: true })
    expect(showTerminal).toHaveBeenCalledWith('term_1')
    expect(requests).toEqual([
      { kind: 'bindLaunchContext', tabId: 'tab-9', worktreeId: 'wt-1', items }
    ])
  })

  it('answers false when an older window does not know the request', async () => {
    const { ctx } = terminalRuntime(undefined)
    await expect(
      method(SESSION_PROJECTS_RPC.bindLaunch).handler({ terminal: 'term_1', items }, ctx)
    ).resolves.toEqual({ bound: false })
  })

  it('refuses a paired device before anything else', async () => {
    const { ctx, showTerminal } = terminalRuntime({ bound: true })
    await expect(
      method(SESSION_PROJECTS_RPC.bindLaunch).handler(
        { terminal: 'term_1', items },
        { ...ctx, clientId: 'phone' }
      )
    ).rejects.toThrow(/Only the omni CLI on this computer/)
    expect(showTerminal).not.toHaveBeenCalled()
  })
})

describe('sessionProjects.list', () => {
  function listRuntime() {
    const { ctx, requests } = runtime()
    Object.assign(ctx.runtime, {
      requestSessionFolders: async (request: SessionFolderRelayRequest) => {
        requests.push(request)
        return request.kind === 'listProjects'
          ? { projects: [{ folderId: FOLDER, name: 'Ads', path: 'Ads', repos: 1 }] }
          : { projectFolderId: FOLDER, rows: [] }
      }
    })
    return { ctx, requests }
  }

  it("answers this computer's CLI and a person on a paired desktop", async () => {
    const expected = {
      projects: [
        {
          folderId: FOLDER,
          name: 'Ads',
          path: 'Ads',
          repos: 1,
          threads: { total: 0, byStatus: {} }
        }
      ]
    }
    const local = listRuntime()
    await expect(method(SESSION_PROJECTS_RPC.list).handler({}, local.ctx)).resolves.toEqual(
      expected
    )
    expect(local.requests.map((request) => request.kind)).toEqual(['listProjects', 'listSessions'])
    const paired = listRuntime()
    await expect(
      method(SESSION_PROJECTS_RPC.list).handler(
        {},
        { ...paired.ctx, clientKind: 'runtime', pairedDeviceId: 'mac-studio' }
      )
    ).resolves.toEqual(expected)
  })

  it('refuses an agent on a paired desktop and other clients before reading anything', async () => {
    for (const caller of [
      {
        clientKind: 'runtime' as const,
        pairedDeviceId: 'mac-studio',
        orchestrationCapability: 'cap'
      },
      { clientKind: 'mobile' as const, pairedDeviceId: 'phone' },
      { clientId: 'phone' }
    ]) {
      const { ctx, requests } = listRuntime()
      await expect(
        method(SESSION_PROJECTS_RPC.list).handler({}, { ...ctx, ...caller } as RpcContext)
      ).rejects.toThrow(/Only the omni CLI on this computer/)
      expect(requests).toEqual([])
    }
  })
})
