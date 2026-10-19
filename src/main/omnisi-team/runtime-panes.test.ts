import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
const mocks = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], deliver: vi.fn() }))
vi.mock(
  '../session-host-owner/main-conversation-inventory',
  () => ({ mainConversationInventory: () => ({ conversations: mocks.rows }) })
)
vi.mock(
  '../native-chat/agent-session-wire/structured-agent-session-registry',
  () => ({ getStructuredAgentSessionHost: () => null })
)
vi.mock('../runtime/conversation-delivery', () => ({ deliverToConversation: mocks.deliver }))
import { assertTeamPaneReady, deliverTeamDirective, readTeamPanes } from './runtime-panes'

const proof = {
  ptyId: 'pty',
  incarnationId: 'incarnation',
  rootPid: 100,
  pid: 101,
  pgid: 101,
  startTimeMs: 12345,
  agent: 'claude',
  via: 'command-line'
}
function harness() {
  const evidence = {
    process: proof as typeof proof | null,
    screen: { readyPrompt: true, working: false, blocked: null as string | null }
  }
  const runtime = {
    readOwnerConversationInventory: () => ({}),
    resolveTerminalPane: () => ({ handle: 'terminal-fake' }),
    readTerminalAgentEvidence: vi.fn(async () => evidence),
    assertTerminalAgentProcess: vi.fn(async () => {})
  }
  return {
    runtime: runtime as unknown as OrcaRuntimeService,
    evidence,
    assert: runtime.assertTerminalAgentProcess
  }
}
beforeEach(() => {
  mocks.deliver.mockReset().mockResolvedValue({ door: 'pty', deliveredAt: 1 })
  mocks.rows = [{
    listed: true,
    rest: 'live',
    worktreeId: 'work-fake',
    paneKey: 'pane-fake',
    conversation: 'conversation-fake',
    agent: 'claude',
    title: 'Claude'
  }]
})
describe('host-owned directive delivery', () => {
  it('refuses a shell or an approval screen before delivering', async () => {
    const h = harness()
    const pane = readTeamPanes(h.runtime)[0]
    h.evidence.process = null
    await expect(assertTeamPaneReady(h.runtime, pane)).rejects.toThrow('not ready')
    await expect(
      deliverTeamDirective(
        h.runtime,
        pane,
        'From OmniSI: task',
        'operation',
        new AbortController().signal
      )
    ).rejects.toThrow('not ready')
    h.evidence.process = proof
    h.evidence.screen.blocked = 'approval'
    await expect(assertTeamPaneReady(h.runtime, pane)).rejects.toThrow('not ready')
    expect(mocks.deliver).not.toHaveBeenCalled()
  })
  it('uses the existing delivery door with a process proof and revocable pane guard', async () => {
    const h = harness()
    const pane = readTeamPanes(h.runtime)[0]
    const abort = new AbortController()
    await deliverTeamDirective(h.runtime, pane, 'From OmniSI: task', 'operation', abort.signal)
    const options = mocks.deliver.mock.calls[0][3]
    expect(options.receiver.process).toEqual(proof)
    await options.receiver.verify('pty')
    expect(h.assert).toHaveBeenCalledWith(proof, 'pty')
    abort.abort()
    expect(() => options.beforeWrite()).toThrow('no longer open')
  })
  it('treats missing inventory as unverifiable, and does not invent closed sessions', () => {
    const h = harness()
    h.runtime.readOwnerConversationInventory = () => null
    expect(() => readTeamPanes(h.runtime)).toThrow('inventory is unavailable')
  })
})
