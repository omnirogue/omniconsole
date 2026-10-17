import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sendInboxStructuredInstruction } from './inbox-structured-instruction'

const callStructuredAgentSession = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({ callStructuredAgentSession }))

function session(overrides: Partial<SidebarSession> = {}): SidebarSession {
  return {
    rowKey: 'structured-row',
    sessionKey: 'structured-key',
    worktreeId: 'wt-one',
    hostId: 'local',
    tabId: 'tab-one',
    paneKey: null,
    kind: 'structured',
    structuredSessionId: 'codex_thread-one',
    label: 'Native AI',
    workspaceLabel: 'Workspace',
    agent: 'Codex',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

function history(sessionId = 'codex_thread-one', fence: number | undefined = 7) {
  return { ok: true, page: { sessionId, fence } }
}

function accepted() {
  return {
    ok: true,
    replayed: false,
    fence: 7,
    cursor: { epoch: 'epoch', sequence: 1 },
    value: {
      clientMessageId: 'operation',
      submission: { dispatchState: 'accepted', submittedAt: 1 }
    }
  }
}

beforeEach(() => {
  callStructuredAgentSession.mockReset()
})

describe('Inbox structured instruction routing', () => {
  it.each([
    ['local', { kind: 'local' }],
    ['runtime:owner-one', { kind: 'environment', environmentId: 'owner-one' }]
  ] as const)('routes an accepted send to its %s owner', async (hostId, target) => {
    callStructuredAgentSession.mockResolvedValueOnce(history()).mockResolvedValueOnce(accepted())

    await expect(
      sendInboxStructuredInstruction(session({ hostId }), ' Do the work ')
    ).resolves.toBeUndefined()

    expect(callStructuredAgentSession).toHaveBeenNthCalledWith(1, target, 'agentSession.history', {
      sessionId: 'codex_thread-one',
      direction: 'tail',
      limit: 1
    })
    expect(callStructuredAgentSession).toHaveBeenNthCalledWith(
      2,
      target,
      'agentSession.send',
      expect.objectContaining({
        envelope: expect.objectContaining({
          sessionId: 'codex_thread-one',
          expectedRuntimeFence: 7
        }),
        body: expect.objectContaining({ role: 'user' })
      })
    )
  })

  it.each([
    ['missing fence', { ok: true, page: { sessionId: 'codex_thread-one' } }],
    ['wrong session', history('codex_thread-other', 7)]
  ])('refuses %s ownership evidence without sending', async (_name, evidence) => {
    callStructuredAgentSession.mockResolvedValueOnce(evidence)

    await expect(sendInboxStructuredInstruction(session(), 'work')).rejects.toThrow(
      'ownership could not be verified'
    )
    expect(callStructuredAgentSession).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['unavailable', session({ unavailable: true })],
    ['SSH', session({ hostId: 'ssh:builder' })],
    ['missing owner', session({ hostId: null })]
  ])('refuses an %s session without a local fallback', async (_name, targetSession) => {
    await expect(sendInboxStructuredInstruction(targetSession, 'work')).rejects.toThrow(
      'unavailable on its execution host'
    )
    expect(callStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('reports a stale-fence refusal and does not resend', async () => {
    callStructuredAgentSession.mockResolvedValueOnce(history()).mockResolvedValueOnce({
      ok: false,
      refusal: {
        code: 'agent_session_checkpoint_stale',
        message: 'The runtime ownership changed.',
        currentFence: 8
      }
    })

    await expect(sendInboxStructuredInstruction(session(), 'work')).rejects.toThrow(
      'The runtime ownership changed.'
    )
    expect(callStructuredAgentSession).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['rejected', 'Provider rejected the instruction.'],
    ['unknown', 'Delivery is unknown.']
  ] as const)('does not treat a %s dispatch as accepted', async (dispatchState, reason) => {
    callStructuredAgentSession.mockResolvedValueOnce(history()).mockResolvedValueOnce({
      ...accepted(),
      value: {
        clientMessageId: 'operation',
        submission: { dispatchState, reason, submittedAt: 1 }
      }
    })

    await expect(sendInboxStructuredInstruction(session(), 'work')).rejects.toThrow(reason)
    expect(callStructuredAgentSession).toHaveBeenCalledTimes(2)
  })

  it('does not resend after an ambiguous transport error', async () => {
    callStructuredAgentSession
      .mockResolvedValueOnce(history())
      .mockRejectedValueOnce(new Error('Connection closed after write'))

    await expect(sendInboxStructuredInstruction(session(), 'work')).rejects.toThrow(
      'Connection closed after write'
    )
    expect(callStructuredAgentSession).toHaveBeenCalledTimes(2)
  })
})
