import { describe, expect, it, vi } from 'vitest'
import type {
  AgentLaunchReadinessResult,
  AgentLaunchHostId
} from '../../shared/agent-launch-account'
import type { RuntimeCreateAgentSessionResult } from '../../shared/agent-session-host-authority'
import { WorkDeliveryHold } from './work-delivery-claimer-types'
import type { ClaimableDelivery, WorkDeliveryTarget } from './work-delivery-kind'
import { respawnFreshSession, respawnRefusal } from './work-delivery-respawn'

const DELIVERY = { key: 'jira:OMR-93:10500', workItem: 'jira:OMR-93' } as ClaimableDelivery
const TARGET: WorkDeliveryTarget = {
  ref: 'codex:conv-1@local',
  model: 'gpt-5.5',
  effort: 'high',
  folder: '/Work/x',
  transcript: 'gone'
}
const OPERATION_ID = `${Date.parse('2026-10-11T18:00:00Z')}-${'a'.repeat(32)}`

function fakeRuntime(hostId: AgentLaunchHostId = 'local') {
  return {
    agentLaunchReadiness: vi.fn(
      async () =>
        ({
          runtimeId: 'rt-1',
          workspace: { id: 'w', hostId, kind: 'folder', path: '/Work/x', name: null }
        }) as AgentLaunchReadinessResult
    ),
    createAgentSession: vi.fn(
      async () =>
        ({
          terminal: { handle: 'h', worktreeId: 'w', tabId: 'tab-9', paneKey: 'tab-9:leaf-1' },
          disposition: 'created'
        }) as unknown as RuntimeCreateAgentSessionResult
    ),
    getTerminalPaneKey: vi.fn(() => null),
    getReportedProviderSessionsForPane: vi.fn(() => [{ id: 'new' }])
  }
}

describe('respawnFreshSession', () => {
  it('launches one sidebar terminal session on a verified account chosen by the workspace host', async () => {
    const runtime = fakeRuntime('ssh:box')
    const pane = await respawnFreshSession(
      runtime as never,
      DELIVERY,
      TARGET,
      'brief',
      OPERATION_ID
    )
    expect(runtime.agentLaunchReadiness).toHaveBeenCalledWith({
      worktree: 'path:/Work/x',
      agent: 'codex',
      preview: false
    })
    const [request, caller] = runtime.createAgentSession.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>
    ]
    // createAgentSession refuses sidebar adoption from a client, or outside an unfocused terminal.
    expect(caller).not.toHaveProperty('clientKind')
    expect(caller).not.toHaveProperty('clientId')
    expect(request).toEqual({
      clientOperationId: OPERATION_ID,
      worktree: 'path:/Work/x',
      agent: 'codex',
      prompt: 'brief',
      promptDelivery: 'auto-submit',
      presentation: 'background',
      revealInSidebar: true,
      viewMode: 'terminal',
      sshAccountSelection: {
        policy: 'best-verified',
        expectedHostId: 'ssh:box',
        expectedRuntimeId: 'rt-1'
      },
      launchPreferences: { model: 'gpt-5.5', effort: 'high' }
    })
    expect(pane).toMatchObject({ paneKey: 'tab-9:leaf-1', conversationId: 'new' })
  })

  it('starts nothing when the folder is unknown or cannot be opened', async () => {
    const runtime = fakeRuntime()
    await expect(
      respawnFreshSession(runtime as never, DELIVERY, { ...TARGET, folder: undefined }, 'b', 'x')
    ).rejects.toMatchObject({ reason: 'not_found' })
    runtime.agentLaunchReadiness.mockRejectedValueOnce(new Error('workspace_not_found'))
    await expect(
      respawnFreshSession(runtime as never, DELIVERY, TARGET, 'b', OPERATION_ID)
    ).rejects.toMatchObject({ reason: 'not_found' })
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
  })
})

describe('respawnRefusal', () => {
  it('retries a refusal before the spawn, and passes an unknown outcome on', () => {
    const noRoom = Object.assign(new Error('No verified account has room.'), {
      code: 'agent_session_account_unverified'
    })
    expect(respawnRefusal(noRoom)).toMatchObject({ reason: 'account_at_limit' })
    expect(respawnRefusal(new Error('agent_session_operation_invalid'))).toBeInstanceOf(
      WorkDeliveryHold
    )
    const lost = Object.assign(new Error('lost'), { agentSessionOperationOutcome: 'unknown' })
    expect(respawnRefusal(lost)).toBe(lost)
  })
})
