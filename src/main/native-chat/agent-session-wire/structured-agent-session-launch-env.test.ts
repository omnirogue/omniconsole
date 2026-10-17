import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { hostTestAttachParams } from './structured-agent-session-host-test-data'
import {
  pinnedAgentSessionLaunchArgs,
  pinnedAgentSessionLaunchEnv,
  pinnedAgentSessionHubTaskId
} from './structured-agent-session-launch-env'

describe('pinnedAgentSessionLaunchEnv', () => {
  it('pins Bypass for a fresh chat without changing model, effort or profile', async () => {
    const params = hostTestAttachParams(null)
    params.options = { chatPermissionMode: 'bypass' }
    await expect(
      pinnedAgentSessionLaunchArgs(
        () => [
          '-s',
          'read-only',
          '-a',
          'on-request',
          '--model',
          'gpt-5',
          '-c',
          'model_reasoning_effort="high"',
          '--profile',
          'review'
        ],
        params
      )
    ).resolves.toEqual({
      launchArgs: [
        '--model',
        'gpt-5',
        '-c',
        'model_reasoning_effort="high"',
        '--profile',
        'review',
        '--dangerously-bypass-approvals-and-sandbox'
      ]
    })
  })

  it('layers the pinned account home over the shell environment', async () => {
    await expect(
      pinnedAgentSessionLaunchEnv(
        async () => ({ EXAMPLE_GATEWAY_TOKEN: 'shell-exported', CODEX_HOME: '/shell/home' }),
        hostTestAttachParams(null)
      )
    ).resolves.toEqual({
      launchEnv: {
        EXAMPLE_GATEWAY_TOKEN: 'shell-exported',
        CODEX_HOME: '/home/dev/.codex'
      }
    })
  })

  it('copies the host-resolved provider arguments into reservation authority', async () => {
    await expect(
      pinnedAgentSessionLaunchArgs(async () => ['--profile', 'review'], hostTestAttachParams(null))
    ).resolves.toEqual({ launchArgs: ['--profile', 'review'] })
  })
})

describe('pinnedAgentSessionHubTaskId', () => {
  it.each(['git-worktree', 'folder'] as const)(
    'pins the host-owned %s workspace link',
    async (workspaceKind) => {
      const resolveHubTaskId = vi.fn(async () => 'btk_1234')
      const params = hostTestAttachParams(null)
      params.location = { ...params.location, workspaceKind }
      await expect(pinnedAgentSessionHubTaskId(resolveHubTaskId, params, null)).resolves.toEqual({
        hubTaskId: 'btk_1234'
      })
      expect(resolveHubTaskId).toHaveBeenCalledWith(params.location.workspaceId)
    }
  )

  it('keeps the durable card when the workspace link changes or disappears during recovery', async () => {
    const resolveHubTaskId = vi.fn(async () => 'btk_5678')
    await expect(
      pinnedAgentSessionHubTaskId(resolveHubTaskId, hostTestAttachParams(2), {
        hubTaskId: 'btk_1234'
      } as AgentSessionRecord)
    ).resolves.toEqual({ hubTaskId: 'btk_1234' })
    expect(resolveHubTaskId).not.toHaveBeenCalled()
  })

  it('does not relabel an already running unbound session when its workspace gets linked', async () => {
    const resolveHubTaskId = vi.fn(async () => 'btk_1234')
    await expect(
      pinnedAgentSessionHubTaskId(
        resolveHubTaskId,
        hostTestAttachParams(1),
        {} as AgentSessionRecord
      )
    ).resolves.toEqual({})
    expect(resolveHubTaskId).not.toHaveBeenCalled()
  })

  it.each([
    { executionHostId: 'ssh:build-box' as const, wslDistro: null },
    { executionHostId: 'local' as const, wslDistro: 'Ubuntu' }
  ])('never reads local links for a foreign execution namespace: %s', async (location) => {
    const resolveHubTaskId = vi.fn(async () => 'btk_1234')
    const params = hostTestAttachParams(null)
    params.location = { ...params.location, ...location }
    await expect(pinnedAgentSessionHubTaskId(resolveHubTaskId, params, null)).resolves.toEqual({})
    expect(resolveHubTaskId).not.toHaveBeenCalled()
  })

  it('leaves an ad-hoc workspace unbound and refuses malformed explicit metadata', async () => {
    await expect(
      pinnedAgentSessionHubTaskId(() => undefined, hostTestAttachParams(null), null)
    ).resolves.toEqual({})
    await expect(
      pinnedAgentSessionHubTaskId(() => 'card\ninjected', hostTestAttachParams(null), null)
    ).rejects.toThrow('agent_session_hub_task_invalid')
  })
})
