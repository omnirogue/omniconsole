import { describe, expect, it, vi } from 'vitest'
import { revokeWriteFencesWhere } from '../runtime/conversation-write-fence'
import { agentEvidence, agentProcess } from './session-manage-test-fixtures'
import { interruptSessionAgent, sessionAgentBackAtPrompt } from './session-manage-runtime-interrupt'

const source = { kind: 'pty' as const, paneKey: 'tab:leaf', worktreeId: 'repo::/w' }

describe('guarded session interrupt', () => {
  it('rechecks the captured conversation and turn at the owning write', async () => {
    let current = true
    const runtime = {
      sendGuardedSessionKey: vi.fn(async (_handle, _key, _receiver, fence) => {
        expect(fence.isRevoked()).toBe(false)
        current = false
        expect(fence.isRevoked()).toBe(true)
        return 'revoked' as const
      }),
      readTerminalAgentEvidence: vi.fn(async () => agentEvidence())
    }
    await expect(
      interruptSessionAgent(runtime, 'h', agentProcess(), source, () => current)
    ).rejects.toThrow('Nothing was interrupted')
  })

  it('invalidates an in-flight owning-writer latch on a newer conversation event', async () => {
    let invalidated = false
    const runtime = {
      sendGuardedSessionKey: vi.fn(async (_handle, key, _receiver, fence) => {
        expect(key).toBe('\x03')
        fence.onClose(() => {
          invalidated = true
        })
        revokeWriteFencesWhere((candidate) => candidate.paneKey === source.paneKey)
        expect(fence.isRevoked()).toBe(true)
        return 'revoked' as const
      }),
      readTerminalAgentEvidence: vi.fn(async () => agentEvidence())
    }
    await expect(interruptSessionAgent(runtime, 'h', agentProcess(), source)).rejects.toThrow(
      'Nothing was interrupted'
    )
    expect(invalidated).toBe(true)
  })

  it('reports transport uncertainty without claiming the interrupt was refused', async () => {
    const runtime = {
      sendGuardedSessionKey: vi.fn(async () => 'unknown' as const),
      readTerminalAgentEvidence: vi.fn(async () => agentEvidence())
    }
    await expect(interruptSessionAgent(runtime, 'h', agentProcess(), source)).rejects.toThrow(
      'could not be confirmed'
    )
  })

  it('requires the same live process and positive ready screen to claim recovery', async () => {
    const evidence = agentEvidence()
    const runtime = {
      sendGuardedSessionKey: vi.fn(async () => 'written' as const),
      readTerminalAgentEvidence: vi.fn(async () => evidence)
    }
    expect(await sessionAgentBackAtPrompt(runtime, 'h', agentProcess())).toBe(false)
    evidence.screen!.readyPrompt = true
    expect(await sessionAgentBackAtPrompt(runtime, 'h', agentProcess())).toBe(true)
    evidence.process = agentProcess({ pid: 999 })
    expect(await sessionAgentBackAtPrompt(runtime, 'h', agentProcess())).toBe(false)
    evidence.process = null
    expect(await sessionAgentBackAtPrompt(runtime, 'h', agentProcess())).toBe(false)
  })
})
