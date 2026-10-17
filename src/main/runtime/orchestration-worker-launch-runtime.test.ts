import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import { OrcaRuntimeService } from './omni-runtime'

const selected = { model: 'gpt-6-astra', effort: 'high' }
const launchEnv = { CODEX_HOME: '/verified/worker/account' }
const workerCause = { trigger: 'orchestration-worker' }
const settingsCodexArgs = '-c check_for_update_on_startup=true --config features.web_search=true'
type Launch = {
  command: string
  env?: Record<string, string>
  launchConfig: SleepingAgentLaunchConfig
}

function harness() {
  const settings = {
    disabledTuiAgents: [],
    agentCmdOverrides: {},
    agentDefaultArgs: { codex: settingsCodexArgs },
    agentDefaultEnv: {}
  }
  const runtime = new OrcaRuntimeService({ getSettings: () => settings } as never)
  const internal = runtime as unknown as {
    buildStartupForAgent: (...args: unknown[]) => Promise<{ startup: Launch }>
    resolveAgentTerminalCreateOptions: (...args: unknown[]) => Promise<Launch>
    getAgentLaunchPlatformForRepo: (...args: unknown[]) => NodeJS.Platform
    getAgentLaunchPlatformForWorkspace: (...args: unknown[]) => NodeJS.Platform
    getHubLinkedWorkspaceItem: (...args: unknown[]) => null
    markWorkspaceTrustedForAgent: (...args: unknown[]) => Promise<void>
    resolveNewSessionOptions: (...args: unknown[]) => Promise<typeof selected>
  }
  vi.spyOn(internal, 'getAgentLaunchPlatformForRepo').mockReturnValue('darwin')
  vi.spyOn(internal, 'getAgentLaunchPlatformForWorkspace').mockReturnValue('darwin')
  vi.spyOn(internal, 'getHubLinkedWorkspaceItem').mockReturnValue(null)
  vi.spyOn(internal, 'markWorkspaceTrustedForAgent').mockResolvedValue()
  vi.spyOn(internal, 'resolveNewSessionOptions').mockResolvedValue(selected)
  return { internal, settings }
}

function expectWorkerLaunch(launch: Launch) {
  expect(launch.command).toContain('check_for_update_on_startup=false')
  expect(launch.command).not.toContain('check_for_update_on_startup=true')
  expect(launch.command).toContain('features.web_search=true')
  expect(launch.command).toContain('gpt-6-astra')
  expect(launch.command).toContain('model_reasoning_effort=')
  expect(launch.command).toContain('high')
  expect(launch.env).toEqual(launchEnv)
  expect(launch.launchConfig.agentEnv).toEqual(launchEnv)
  // Why: the durable record is replayed verbatim by a later human resume; the suppression stays
  // scoped to this managed launch and the operator's own updater setting survives.
  expect(launch.launchConfig.agentArgs).toBe(settingsCodexArgs)
  expect(launch.launchConfig.agentCommand).toContain('check_for_update_on_startup=true')
  expect(launch.launchConfig.agentCommand).not.toContain('check_for_update_on_startup=false')
}

describe('worker startup config through both runtime launch builders', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(['folder', 'git'])(
    'applies to an existing %s workspace without changing settings',
    async (kind) => {
      const { internal, settings } = harness()
      const before = structuredClone(settings)
      const workspace = {
        id: 'worker',
        path: '/workspace',
        connectionId: null,
        repo: kind === 'git' ? { id: 'repo', path: '/workspace', connectionId: null } : null,
        folderWorkspace: kind === 'folder' ? { id: 'worker', path: '/workspace' } : null
      }
      const launch = await internal.resolveAgentTerminalCreateOptions(workspace, {
        startupAgent: 'codex',
        launchCause: workerCause,
        agentLaunchEnv: launchEnv,
        launchPreferences: selected
      })
      expectWorkerLaunch(launch)
      expect(settings).toEqual(before)
      const human = await internal.resolveAgentTerminalCreateOptions(workspace, {
        startupAgent: 'codex',
        launchCause: { trigger: 'person-reveal' },
        agentLaunchEnv: launchEnv,
        launchPreferences: selected
      })
      expect(human.command).toContain('check_for_update_on_startup=true')
      expect(human.command).not.toContain('check_for_update_on_startup=false')
    }
  )

  it('applies to a new worktree builder and preserves ordinary new-session settings', async () => {
    const { internal, settings } = harness()
    const before = structuredClone(settings)
    const repo = { id: 'repo', path: '/workspace', connectionId: null }
    const worker = await internal.buildStartupForAgent(
      repo,
      'codex',
      undefined,
      selected,
      undefined,
      launchEnv,
      undefined,
      undefined,
      workerCause
    )
    expectWorkerLaunch(worker.startup)
    expect(settings).toEqual(before)
    const human = await internal.buildStartupForAgent(
      repo,
      'codex',
      undefined,
      selected,
      undefined,
      launchEnv
    )
    expect(human.startup.command).toContain('check_for_update_on_startup=true')
    expect(human.startup.command).not.toContain('check_for_update_on_startup=false')
  })
})
