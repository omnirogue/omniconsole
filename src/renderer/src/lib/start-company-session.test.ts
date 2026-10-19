// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, text: string) => text }))
const launchFolderWorkspaceAgentSession = vi.fn()
vi.mock('@/lib/folder-workspace-agent-launch', () => ({
  launchFolderWorkspaceAgentSession: (args: unknown) => launchFolderWorkspaceAgentSession(args)
}))

const launchAgentInNewTab = vi.fn()
vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: (args: unknown) => launchAgentInNewTab(args)
}))
const storeState = {
  unifiedTabsByWorktree: {} as Record<string, { id: string; entityId: string }[]>,
  activeGroupIdByWorktree: {} as Record<string, string>,
  groupsByWorktree: {},
  settings: {
    companyWorkRoot: '~/Work',
    companyFolders: {} as Record<string, string>,
    agentCmdOverrides: {}
  },
  projectGroups: [] as { id: string; name: string; parentPath?: string | null }[],
  folderWorkspaces: [] as { id: string; folderPath: string }[],
  updateSettingsOrThrow: vi.fn().mockResolvedValue(undefined),
  createProjectGroup: vi.fn(),
  createFolderWorkspace: vi.fn()
}
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))

import {
  resetCompanyFolderHomeCache,
  resolveCompanySessionFolder,
  startCompanySession
} from './start-company-session'
import { selectConsoleAccountScope } from './console-account-scope'
import { useAppStore } from '@/store'

const ensureFolder = vi.fn()
const getPathStatus = vi.fn()

beforeEach(() => {
  resetCompanyFolderHomeCache()
  launchFolderWorkspaceAgentSession.mockReset()
  // Why: the helper now says whether the workspace was revealed; a start is only a start when it was.
  launchFolderWorkspaceAgentSession.mockImplementation(async (args) => {
    args.beforeActivate?.()
    args.onLaunched?.('folder:workspace-1', 'new-tab')
    return true
  })
  launchAgentInNewTab.mockReset().mockReturnValue({ tabId: 'another-tab' })
  storeState.unifiedTabsByWorktree = {}
  storeState.activeGroupIdByWorktree = {}
  ensureFolder.mockReset()
  getPathStatus.mockReset()
  storeState.settings = {
    companyWorkRoot: '~/Work',
    companyFolders: {},
    agentCmdOverrides: {}
  }
  storeState.projectGroups = []
  storeState.folderWorkspaces = []
  storeState.createProjectGroup = vi.fn(async (name: string) => ({ id: 'group-1', name }))
  storeState.createFolderWorkspace = vi.fn(async (args: { folderPath?: string | null }) => ({
    id: 'workspace-1',
    folderPath: args.folderPath ?? '',
    connectionId: null
  }))
  getPathStatus.mockResolvedValue({ path: '', exists: true })
  Object.assign(window as unknown as { api: unknown }, {
    api: {
      companyWorkspaces: { home: () => Promise.resolve('/Users/maintainer'), ensureFolder },
      folderWorkspaces: { getPathStatus }
    }
  })
})

const omnirogue = { slug: 'omnirogue', name: 'OmniRogue' }

describe('resolveCompanySessionFolder', () => {
  it('follows the estate convention down to the department', async () => {
    expect(
      await resolveCompanySessionFolder({
        company: omnirogue,
        domain: { id: 'dom_ads', name: 'Marketing' }
      })
    ).toBe('/Users/maintainer/Work/OmniRogue/Marketing')
  })

  it('honours the saved override for the company', async () => {
    storeState.settings.companyFolders = { apexlabs: '~/Code/cf' }
    expect(
      await resolveCompanySessionFolder({
        company: { slug: 'apexlabs', name: 'ApexLabs' },
        domain: { id: 'dom_cs', name: 'Customer Service' }
      })
    ).toBe('/Users/maintainer/Code/cf/Customer Service')
  })
})

describe('startCompanySession', () => {
  it('refuses a customer-service launch after the signed-in account changes', async () => {
    const result = await startCompanySession({
      company: omnirogue,
      domain: null,
      agent: 'claude',
      note: '',
      expectedAccountScope: 'a different account'
    })
    expect(result.ok).toBe(false)
    expect(storeState.createFolderWorkspace).not.toHaveBeenCalled()
    expect(launchFolderWorkspaceAgentSession).not.toHaveBeenCalled()
  })
  it('checks identity again after asynchronous agent trust preflight', async () => {
    const scope = selectConsoleAccountScope(useAppStore.getState())
    launchFolderWorkspaceAgentSession.mockImplementationOnce(async (args) => {
      // An environment switch changes which signed-in Console principal receives the work.
      Object.assign(storeState.settings, { backofficeEnv: 'local' })
      args.beforeActivate?.()
      return true
    })
    await expect(
      startCompanySession({
        company: omnirogue,
        domain: null,
        agent: 'claude',
        note: '',
        expectedAccountScope: scope
      })
    ).rejects.toThrow('signed-in account changed')
    expect(launchAgentInNewTab).not.toHaveBeenCalled()
  })
  it('starts an unscoped conversation in Work without a company or department', async () => {
    await startCompanySession({
      company: null,
      domain: null,
      agent: 'claude',
      note: '',
      conversationLauncher: true
    })
    expect(getPathStatus).toHaveBeenCalledWith({ scope: 'path', path: '/Users/maintainer/Work' })
    expect(storeState.createFolderWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Work', folderPath: '/Users/maintainer/Work' }),
      { runtimeEnvironmentId: null }
    )
  })
  it('carries the chosen account and model through a company launch', async () => {
    await startCompanySession({
      company: omnirogue,
      domain: null,
      agent: 'claude',
      note: '',
      conversationLauncher: true,
      launchEnv: { CLAUDE_CONFIG_DIR: '/owned/account' },
      launchPreferences: { model: 'sonnet', effort: 'high' }
    })
    const plan = launchFolderWorkspaceAgentSession.mock.calls[0][0].startupPlan
    expect(plan.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/owned/account' })
    expect(plan.launchCommand).toContain('command claude')
    expect(plan.launchCommand).toContain('sonnet')
    expect(plan.launchCommand).toContain('high')
  })
  it('reports a missing folder instead of creating a session for it', async () => {
    getPathStatus.mockResolvedValue({ path: '', exists: false, reason: 'missing' })

    const result = await startCompanySession({
      company: omnirogue,
      domain: { id: 'dom_ads', name: 'Marketing' },
      agent: 'claude',
      note: ''
    })

    expect(result).toEqual({
      ok: false,
      reason: 'folder-missing',
      path: '/Users/maintainer/Work/OmniRogue/Marketing'
    })
    expect(storeState.createFolderWorkspace).not.toHaveBeenCalled()
  })

  it('creates the company group and the department workspace, then launches the agent', async () => {
    const result = await startCompanySession({
      company: omnirogue,
      domain: { id: 'dom_ads', name: 'Marketing' },
      agent: 'claude',
      note: 'Check yesterday’s spend'
    })

    expect(storeState.createProjectGroup).toHaveBeenCalledWith('OmniRogue', {
      parentPath: '/Users/maintainer/Work/OmniRogue',
      runtimeEnvironmentId: null
    })
    expect(storeState.createFolderWorkspace).toHaveBeenCalledWith(
      {
        projectGroupId: 'group-1',
        name: 'OmniRogue · Marketing',
        folderPath: '/Users/maintainer/Work/OmniRogue/Marketing',
        createdWithAgent: 'claude'
      },
      { runtimeEnvironmentId: null }
    )
    const launch = launchFolderWorkspaceAgentSession.mock.calls[0][0]
    expect(launch.agent).toBe('claude')
    expect(launch.launchSource).toBe('companies')
    expect(launch.startupPlan.launchCommand).toContain('claude')
    expect(result).toEqual({ ok: true, workspaceId: 'workspace-1', tabId: 'new-tab' })
  })

  it('reuses the existing group and workspace for the same folder', async () => {
    storeState.projectGroups = [
      { id: 'group-9', name: 'OmniRogue', parentPath: '/Users/maintainer/Work/OmniRogue/' }
    ]
    storeState.folderWorkspaces = [
      { id: 'workspace-9', folderPath: '/Users/maintainer/Work/OmniRogue/Marketing' }
    ]

    const result = await startCompanySession({
      company: omnirogue,
      domain: { id: 'dom_ads', name: 'Marketing' },
      agent: null,
      note: ''
    })

    expect(storeState.createProjectGroup).not.toHaveBeenCalled()
    expect(storeState.createFolderWorkspace).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, workspaceId: 'workspace-9', tabId: 'new-tab' })
    expect(launchFolderWorkspaceAgentSession.mock.calls[0][0].startupPlan).toBeNull()
  })

  it('starts at the company folder when no department was chosen', async () => {
    await startCompanySession({ company: omnirogue, domain: null, agent: null, note: '' })

    expect(storeState.createFolderWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'OmniRogue',
        folderPath: '/Users/maintainer/Work/OmniRogue'
      }),
      { runtimeEnvironmentId: null }
    )
  })

  it('says so rather than launching when the workspace cannot be created', async () => {
    storeState.createFolderWorkspace = vi.fn(async () => null)

    const result = await startCompanySession({
      company: omnirogue,
      domain: null,
      agent: 'claude',
      note: ''
    })

    expect(result).toEqual({
      ok: false,
      reason: 'failed',
      message: 'The session folder could not be opened, so no agent was started.'
    })
    expect(launchFolderWorkspaceAgentSession).not.toHaveBeenCalled()
  })
})

it('opens a new conversation when company activation reuses existing tabs', async () => {
  storeState.folderWorkspaces = [{ id: 'workspace-9', folderPath: '/Users/maintainer/Work/OmniRogue' }]
  launchFolderWorkspaceAgentSession.mockImplementation(async (args) => {
    args.beforeActivate?.()
    return true
  })
  const result = await startCompanySession({
    company: omnirogue,
    domain: null,
    agent: 'claude',
    note: '',
    conversationLauncher: true,
    launchEnv: { CLAUDE_CONFIG_DIR: '/owned/account' },
    launchPreferences: { model: 'sonnet', effort: 'high' },
    viewModePreference: 'chat'
  })
  expect(result).toEqual({ ok: true, workspaceId: 'workspace-9', tabId: 'another-tab' })
  expect(launchAgentInNewTab).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      worktreeId: 'folder:workspace-9',
      conversationLauncher: true,
      launchEnv: { CLAUDE_CONFIG_DIR: '/owned/account' },
      launchPreferences: { model: 'sonnet', effort: 'high' },
      viewModePreference: 'chat'
    })
  )
})

it('does not duplicate a newly seeded company conversation', async () => {
  await startCompanySession({
    company: omnirogue,
    domain: null,
    agent: 'claude',
    note: '',
    conversationLauncher: true
  })
  expect(launchAgentInNewTab).not.toHaveBeenCalled()
})

it('reports failure when the existing company workspace cannot launch a new tab', async () => {
  launchFolderWorkspaceAgentSession.mockResolvedValue(true)
  launchAgentInNewTab.mockReturnValue(null)
  expect(
    await startCompanySession({
      company: omnirogue,
      domain: null,
      agent: 'claude',
      note: '',
      conversationLauncher: true
    })
  ).toMatchObject({ ok: false, reason: 'failed' })
})
