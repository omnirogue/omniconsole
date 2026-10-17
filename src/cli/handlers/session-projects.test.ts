import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyProjectSettings } from '../../shared/project-settings'
import type { SessionProjectReadResult } from '../../shared/session-project-cli'
import { parseArgs } from '../args'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { projectTerminalWarning, SESSION_PROJECT_HANDLERS } from './session-projects'

function client(call: (...args: unknown[]) => Promise<unknown>): RuntimeClient {
  return { call, isRemote: false } as unknown as RuntimeClient
}

const read = (settings: SessionProjectReadResult['project']): SessionProjectReadResult => ({
  folder: { id: 'folder-1', name: 'Reviews', path: 'Ads / Reviews' },
  project: settings
})

describe('projectTerminalWarning', () => {
  it('names the commands that inherit when a plain terminal is filed in a project', async () => {
    const call = vi.fn(async () => ({
      result: read({
        folderId: 'project-1',
        name: 'Ads',
        path: 'Ads',
        settings: emptyProjectSettings(1)
      })
    }))
    const warning = await projectTerminalWarning(client(call), 'folder-1')
    expect(call).toHaveBeenCalledWith('sessionProjects.show', { folder: 'folder-1' })
    expect(warning).toBe(
      '“Ads” is a project, but a terminal made with --folder does not inherit it. For a thread that does, use omni session launch --folder folder-1 or omni orchestration worker-start --project folder-1.'
    )
  })

  it('says nothing for a folder in no project, or when the runtime cannot tell', async () => {
    expect(
      await projectTerminalWarning(
        client(async () => ({ result: read(null) })),
        'folder-1'
      )
    ).toBeNull()
    expect(
      await projectTerminalWarning(
        client(async () => {
          throw new RuntimeClientError('method_not_found', 'Unknown method')
        }),
        'folder-1'
      )
    ).toBeNull()
  })
})

describe('omni folder project', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const settings = {
    ...emptyProjectSettings(1),
    coordinator: {
      launch: { agent: 'codex' as const, effort: 'high', team: true },
      sessionKey: 'key-1'
    },
    tasks: [
      {
        provider: 'jira' as const,
        cloud_id: 'bb6f9191-a21a-4857-b965-32de82dce68b',
        issue_id: '10001',
        issue_key: 'ADS-12',
        project_key: 'ADS'
      }
    ]
  }

  const scope = {
    source: 'controller-sidebar',
    includeArchived: false,
    project: { folderId: 'project-1', name: 'Ads', path: 'Ads' }
  }

  async function run(list: () => Promise<unknown>, json = false) {
    const call = vi.fn(async (...args: unknown[]) =>
      args[0] === 'sessionProjects.show'
        ? { result: read({ folderId: 'project-1', name: 'Ads', path: 'Ads', settings }) }
        : list()
    )
    await SESSION_PROJECT_HANDLERS['folder project']!({
      flags: parseArgs(['folder', 'project', '--folder', 'Ads / Reviews']).flags,
      client: client(call),
      cwd: '/tmp',
      json
    })
    return { call, printed: String(vi.mocked(console.log).mock.calls.at(-1)?.[0]) }
  }

  it('shows the coordinator, the threads by status and the issues', async () => {
    const sessions = [
      { projectCoordinator: true, projectStatus: 'needsYou' },
      { projectStatus: 'working' },
      { projectStatus: 'working' },
      { projectStatus: 'reviewReady' },
      { projectStatus: null }
    ]
    const { call, printed } = await run(async () => ({ result: { sessions, scope } }))
    expect(call).toHaveBeenCalledWith('sessionManage.list', { project: 'project-1' })
    expect(printed).toContain('  coordinator codex · effort high · team · chat waiting on you')
    expect(printed).toContain('  threads 4: 2 working, 1 ready for review, 1 idle')
    expect(printed).toContain('  issue ADS-12 https://example-team.atlassian.net/browse/ADS-12')
  })

  it('still prints the settings when the threads cannot be listed', async () => {
    const { printed } = await run(async () => {
      throw new RuntimeClientError('runtime_unavailable', 'No window')
    })
    expect(printed).toContain('  coordinator codex · effort high · team\n')
    expect(printed).not.toContain('  threads')
    expect(printed).toContain('  issue ADS-12')
  })

  it('leaves the counts out when an older OmniConsole lists every session', async () => {
    const { printed } = await run(async () => ({ result: { sessions: [{ projectStatus: null }] } }))
    expect(printed).not.toContain('  threads')
    expect(printed).toContain('  coordinator codex · effort high · team\n')
  })

  it('adds the counts to JSON, with no project chat running', async () => {
    const { printed } = await run(
      async () => ({ result: { sessions: [{ projectStatus: 'done' }], scope } }),
      true
    )
    expect(JSON.parse(printed).result.threads).toEqual({ total: 1, byStatus: { done: 1 } })
  })
})

describe('omni folder projects', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function run(projects: unknown[]) {
    const call = vi.fn(async () => ({ result: { projects } }))
    await SESSION_PROJECT_HANDLERS['folder projects']!({
      flags: parseArgs(['folder', 'projects']).flags,
      client: { call, isRemote: true } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    })
    return { call, printed: String(vi.mocked(console.log).mock.calls.at(-1)?.[0]) }
  }

  it('lists each project with its coordinator and threads, from a paired desktop too', async () => {
    const { call, printed } = await run([
      {
        folderId: 'project-1',
        name: 'Ads',
        path: 'Ads',
        repos: 2,
        coordinator: { agent: 'claude', team: true },
        threads: { total: 3, byStatus: { working: 2, needsYou: 1 }, chat: 'working' }
      },
      { folderId: 'project-2', name: 'SEO', path: 'SEO', repos: 0, threads: null }
    ])
    expect(call).toHaveBeenCalledWith('sessionProjects.list', {})
    expect(printed).toBe(
      [
        'Ads  id project-1  repos 2',
        '  coordinator claude · team · chat working',
        '  threads 3: 2 working, 1 waiting on you',
        'SEO  id project-2  repos 0'
      ].join('\n')
    )
  })

  it('says how a project is made when there is none', async () => {
    const { printed } = await run([])
    expect(printed).toBe(
      'No projects on this computer. A person sets a folder up as one in OmniConsole.'
    )
  })
})
