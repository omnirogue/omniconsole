import { describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { revokeWriteFencesWhere } from '../runtime/conversation-write-fence'
import { watchNewTransferTarget } from './session-transfer-new-target'

const hooks = vi.hoisted(() => ({
  listener: null as ((event: AgentHookEventPayload) => void) | null
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    subscribeEnrichedStatus: (listener: (event: AgentHookEventPayload) => void) => {
      hooks.listener = listener
      return () => {
        hooks.listener = null
      }
    }
  }
}))
const source = { kind: 'pty' as const, worktreeId: 'worktree', paneKey: 'new-pane' }
const start = {
  paneKey: source.paneKey,
  connectionId: null,
  hookEventName: 'SessionStart',
  sessionStartSource: 'startup',
  payload: { state: 'done' }
} as AgentHookEventPayload

function fixture() {
  const proof = watchNewTransferTarget(source)
  const runtime = {
    resolveTerminalPane: vi.fn(() => ({
      handle: 'new-handle',
      tabId: 'tab',
      leafId: 'leaf',
      ptyId: 'new-pty',
      connected: true
    }))
  }
  proof.bind({ handle: 'new-handle', ptyId: 'new-pty' })
  return { proof, runtime }
}

describe('new transfer target birth proof', () => {
  it('authorizes only its live original PTY and never another conversation', () => {
    const { proof, runtime } = fixture()
    try {
      expect(proof.neverReplied(runtime, source)).toBe(false)
      hooks.listener?.(start)
      expect(proof.neverReplied(runtime, source)).toBe(true)
      expect(proof.neverReplied(runtime, { ...source, paneKey: 'older-pane' })).toBe(false)
      runtime.resolveTerminalPane.mockReturnValue({
        handle: 'new-handle',
        tabId: 'tab',
        leafId: 'leaf',
        ptyId: 'replacement',
        connected: true
      })
      expect(proof.neverReplied(runtime, source)).toBe(false)
    } finally {
      proof.close()
    }
  })
  it.each(['input', 'turn'] as const)(
    'revokes permanently on %s even before launch binds',
    (reason) => {
      const proof = watchNewTransferTarget(source)
      revokeWriteFencesWhere((candidate) => candidate.paneKey === source.paneKey, reason)
      proof.bind({ handle: 'new-handle', ptyId: 'new-pty' })
      expect(
        proof.neverReplied(
          {
            resolveTerminalPane: () => ({
              handle: 'new-handle',
              tabId: 'tab',
              leafId: 'leaf',
              ptyId: 'new-pty',
              connected: true
            })
          },
          source
        )
      ).toBe(false)
      proof.close()
    }
  )
  it('permits an empty live start event but refuses subsequent prompt activity', () => {
    const { proof, runtime } = fixture()
    hooks.listener?.(start)
    expect(proof.neverReplied(runtime, source)).toBe(true)
    hooks.listener?.({ ...start, hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true })
    hooks.listener?.(start)
    expect(proof.neverReplied(runtime, source)).toBe(false)
    proof.close()
  })
  it.each(['resume', 'clear', undefined] as const)(
    'does not treat an empty %s event as a fresh conversation',
    (sessionStartSource) => {
      const { proof, runtime } = fixture()
      hooks.listener?.({ ...start, sessionStartSource })
      hooks.listener?.(start)
      expect(proof.neverReplied(runtime, source)).toBe(false)
      proof.close()
    }
  )
})
