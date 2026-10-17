import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import {
  agentLaunchRefusal,
  type AgentLaunchAccountReceipt
} from '../../shared/agent-launch-account'
import { SessionPrepAccountPreparationError } from '../session-prep/session-prep-ids'
import {
  assertLaunchModelVerified,
  prepareAgentSessionHostAccount
} from './agent-session-host-account'
import { prepareAgentSessionLocalAccount } from './agent-session-local-account'
import { prepareAgentSessionSshAccount } from './agent-session-ssh-account'

vi.mock('./agent-session-local-account', () => ({ prepareAgentSessionLocalAccount: vi.fn() }))
vi.mock('./agent-session-ssh-account', () => ({ prepareAgentSessionSshAccount: vi.fn() }))

const workspace = {
  id: 'repo::/work',
  path: '/work',
  connectionId: null,
  repo: { id: 'repo', path: '/repo' },
  folderWorkspace: null
}

function input(expectedHostId?: string) {
  const request: RuntimeCreateAgentSessionRequest = {
    clientOperationId: 'unused',
    worktree: 'id:repo::/work',
    agent: 'codex',
    viewMode: 'terminal',
    ...(expectedHostId
      ? {
          sshAccountSelection: {
            policy: 'best-verified' as const,
            expectedHostId,
            expectedRuntimeId: '11111111-1111-4111-8111-111111111111'
          }
        }
      : {})
  }
  return {
    request,
    workspace,
    currentWorkspace: () => workspace,
    runsInWsl: () => false,
    capacity: null
  }
}

const prepared = {
  env: { CODEX_HOME: '/accounts/codex' },
  assertCurrent: vi.fn(),
  fableVerified: false
}

describe('host-owned launch account dispatcher', () => {
  beforeEach(() => vi.clearAllMocks())

  it('routes local to the local picker and ssh: to the relay picker', async () => {
    vi.mocked(prepareAgentSessionLocalAccount).mockResolvedValue(prepared as never)
    vi.mocked(prepareAgentSessionSshAccount).mockResolvedValue(prepared as never)
    await expect(prepareAgentSessionHostAccount(input())).resolves.toBeNull()
    expect(prepareAgentSessionLocalAccount).not.toHaveBeenCalled()
    expect(prepareAgentSessionSshAccount).not.toHaveBeenCalled()

    await prepareAgentSessionHostAccount(input('local'))
    expect(prepareAgentSessionLocalAccount).toHaveBeenCalledTimes(1)
    expect(prepareAgentSessionSshAccount).not.toHaveBeenCalled()

    await prepareAgentSessionHostAccount(input('ssh:worker'))
    expect(prepareAgentSessionSshAccount).toHaveBeenCalledTimes(1)
    expect(prepareAgentSessionLocalAccount).toHaveBeenCalledTimes(1)
  })

  it('tags SSH capacity refusals with agent_session_account_unverified and keeps their text and class', async () => {
    const text =
      'No codex account has fresh verified capacity on this SSH host. Check its signed-in accounts and usage; nothing launched.'
    const relay = new SessionPrepAccountPreparationError(text)
    vi.mocked(prepareAgentSessionSshAccount).mockRejectedValueOnce(relay)
    const error = await prepareAgentSessionHostAccount(input('ssh:worker')).catch(
      (reason: unknown) => reason
    )
    expect(error).toBe(relay)
    expect(error).toBeInstanceOf(SessionPrepAccountPreparationError)
    expect(error).toMatchObject({ code: 'agent_session_account_unverified', message: text })

    const mismatch = agentLaunchRefusal('agent_session_host_mismatch', 'Not that host.')
    vi.mocked(prepareAgentSessionSshAccount).mockRejectedValueOnce(mismatch)
    await expect(prepareAgentSessionHostAccount(input('ssh:worker'))).rejects.toMatchObject({
      code: 'agent_session_host_mismatch'
    })
  })

  it('refuses a resolved Fable model whose window was not verified', () => {
    const unverified = {
      fableVerified: false,
      receipt: { hostId: 'local' } as AgentLaunchAccountReceipt
    }
    let thrown: unknown
    try {
      assertLaunchModelVerified(unverified, 'claude-fable-1')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({
      code: 'agent_session_account_unverified',
      message: expect.stringContaining(
        "resolves to claude-fable-1 on this computer, but the chosen account's Fable window was not verified. Nothing launched."
      )
    })
    expect(() => assertLaunchModelVerified(unverified, 'opus')).not.toThrow()
    expect(() => assertLaunchModelVerified(unverified, undefined)).not.toThrow()
    expect(() =>
      assertLaunchModelVerified({ ...unverified, fableVerified: true }, 'claude-fable-1')
    ).not.toThrow()
    expect(() => assertLaunchModelVerified(null, 'claude-fable-1')).not.toThrow()
  })
})
