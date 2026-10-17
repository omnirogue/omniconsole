import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusEvent } from '../../shared/agent-session-wire'
import {
  chatSummaryAttention,
  followChatAttention,
  hookRowAttention,
  readChatAttention
} from './next-step-keep-going-feeds'

describe('keep going attention', () => {
  it('reads a PTY hook row: a question or permission prompt, or a failed turn', () => {
    expect(hookRowAttention({ state: 'waiting' })).toBe('agent-waiting')
    expect(hookRowAttention({ state: 'blocked' })).toBe('agent-waiting')
    expect(hookRowAttention({ state: 'done', interactivePrompt: 'Pick one' })).toBe('agent-waiting')
    expect(hookRowAttention({ state: 'done', failed: true })).toBe('turn-failed')
    expect(hookRowAttention({ state: 'done' })).toBeNull()
    expect(hookRowAttention({ state: 'working' })).toBeNull()
  })

  it('reads a chat session: its attention status, or a settled failed turn', () => {
    const turnState = vi.fn(() => ({ outcome: 'failed' }))
    const host = { turnState } as never
    expect(chatSummaryAttention({ sessionId: 's', status: 'attention' }, null)).toBe(
      'agent-waiting'
    )
    expect(chatSummaryAttention({ sessionId: 's', status: 'idle' }, host)).toBe('turn-failed')
    // A failure is a failure while the session still reads as working.
    expect(chatSummaryAttention({ sessionId: 's', status: 'working' }, host)).toBe('turn-failed')
    expect(chatSummaryAttention({ sessionId: 's', status: 'working', failed: true }, null)).toBe(
      'turn-failed'
    )
    const settled = { turnState: () => ({ outcome: 'completed' }) } as never
    expect(chatSummaryAttention({ sessionId: 's', status: 'working' }, settled)).toBeNull()
    const live = {
      liveSessionStatusSummaries: () => [{ sessionId: 's', status: 'attention' }],
      turnState
    } as never
    expect(
      readChatAttention(live, { worktreeId: 'w', paneKey: 'p', kind: 'structured', sessionId: 's' })
    ).toBe('agent-waiting')
    expect(readChatAttention(null, { worktreeId: 'w', paneKey: 'p', kind: 'pty' })).toBeNull()
  })

  it('reports a chat session turning to attention, and detaches on stop', () => {
    let emit: ((event: AgentSessionStatusEvent) => void) | null = null
    const detach = vi.fn()
    const host = {
      subscribeStatus: (subscriber: { emit: (event: AgentSessionStatusEvent) => void }) => {
        emit = subscriber.emit
        return detach
      },
      turnState: () => ({ outcome: 'completed' })
    } as never
    const onAttention = vi.fn()
    const stop = followChatAttention({
      getHost: () => host,
      subscribeHostChanges: () => () => {},
      onAttention
    })
    const session = { sessionId: 's', workspaceId: 'w', latestPrompt: '', updatedAt: 1 }
    emit!({ type: 'status', session: { ...session, status: 'working' } } as never)
    emit!({ type: 'status', session: { ...session, status: 'attention' } } as never)
    emit!({ type: 'status', session: { ...session, status: 'working', failed: true } } as never)
    expect(onAttention.mock.calls.map((call) => call[1])).toEqual(['agent-waiting', 'turn-failed'])
    expect(onAttention.mock.calls[0]![0]).toMatchObject({ worktreeId: 'w', sessionId: 's' })
    stop()
    expect(detach).toHaveBeenCalled()
  })
})
