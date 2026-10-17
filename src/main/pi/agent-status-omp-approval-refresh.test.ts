import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness,
  type HookContext
} from './agent-status-extension-test-harness'

const REQUEST = {
  toolName: 'bash',
  toolCallId: 'copy-1',
  sessionId: 'native-1',
  reason: 'write approval required',
  approvalMode: 'write'
}
const INPUT = { command: 'cp -n source.txt receipt.txt' }
const context = (): HookContext => ({
  sessionManager: {
    getSessionId: () => 'native-1',
    getSessionFile: () => '/sessions/native-1.jsonl'
  }
})
const posts = (harness: AgentStatusExtensionHarness) =>
  harness.fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).payload)

async function park(harness: AgentStatusExtensionHarness, ctx = context()) {
  await harness.callHook('tool_execution_start', { ...REQUEST, args: INPUT }, ctx)
  await vi.advanceTimersByTimeAsync(0)
  await harness.callHook('tool_approval_requested', REQUEST, ctx)
  await vi.advanceTimersByTimeAsync(0)
  harness.fetchMock.mockClear()
}

afterEach(() => vi.useRealTimers())

describe('OMP pending approval renewal', () => {
  it.each([
    ['configured OMP', { kind: 'omp' as const }],
    ['routed OMP', { kind: 'pi' as const, title: 'omp' }]
  ])('recovers the exact %s approval through a changed receiver endpoint', async (_name, args) => {
    vi.useFakeTimers()
    let endpointVersion = 1
    const harness = createAgentStatusExtensionHarness({
      ...args,
      env: { ORCA_AGENT_HOOK_ENDPOINT: '/hook-endpoint' },
      readFileSync: () =>
        `ORCA_AGENT_HOOK_PORT=${4320 + endpointVersion}\nORCA_AGENT_HOOK_TOKEN=token-${endpointVersion}\n`,
      statSync: () => ({ mtimeMs: endpointVersion, size: 80, ino: endpointVersion })
    })
    await park(harness)
    endpointVersion = 2

    await vi.advanceTimersByTimeAsync(10_000)

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4322/hook/omp')
    expect(posts(harness)).toEqual([
      {
        hook_event_name: 'tool_approval_requested',
        session_id: 'native-1',
        tool_name: 'bash',
        tool_call_id: 'copy-1',
        tool_input: INPUT,
        reason: REQUEST.reason,
        approval_mode: REQUEST.approvalMode
      }
    ])
    expect(harness.fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'X-Orca-Agent-Hook-Token': 'token-2',
      'X-Omni-Agent-Hook-Token': 'token-2'
    })
    // A parked native tool stays observable beyond the receiver's 30-minute cache limit.
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(posts(harness)).toHaveLength(187)
    expect(posts(harness).every((post) => post.hook_event_name === 'tool_approval_requested')).toBe(
      true
    )
    await harness.callHook('tool_approval_resolved', { ...REQUEST, approved: true }, context())
    await vi.advanceTimersByTimeAsync(0)
    const settled = harness.fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.fetchMock).toHaveBeenCalledTimes(settled)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    'tool_approval_resolved',
    'tool_execution_end',
    'agent_start',
    'agent_end',
    'agent_settled',
    'session_shutdown'
  ])('stops renewing after %s without replaying approval', async (eventName) => {
    vi.useFakeTimers()
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await park(harness)
    await harness.callHook(eventName, { ...REQUEST, approved: false }, context())
    await vi.advanceTimersByTimeAsync(0)
    harness.fetchMock.mockClear()

    await vi.advanceTimersByTimeAsync(60_000)

    expect(harness.fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the current approval when a different tool finishes or the turn will continue', async () => {
    vi.useFakeTimers()
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await park(harness)
    await harness.callHook('tool_execution_end', { toolCallId: 'other-tool' }, context())
    await harness.callHook('agent_end', { willContinue: true }, context())
    await vi.advanceTimersByTimeAsync(0)
    harness.fetchMock.mockClear()

    await vi.advanceTimersByTimeAsync(10_000)

    expect(posts(harness)).toMatchObject([{ tool_call_id: 'copy-1' }])
  })

  it.each(['native-id', 'session-file', 'disposed-context', 'new-hook-session'])(
    'retires the renewal when identity changes through %s',
    async (change) => {
      vi.useFakeTimers()
      const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
      const ctx = context()
      await park(harness, ctx)
      const manager = ctx.sessionManager!
      if (change === 'native-id') {
        manager.getSessionId = () => 'replacement'
      }
      if (change === 'session-file') {
        manager.getSessionFile = () => '/different.jsonl'
      }
      if (change === 'disposed-context') {
        manager.getSessionId = () => {
          throw new Error('disposed')
        }
      }
      if (change === 'new-hook-session') {
        await harness.callHook(
          'message_end',
          {},
          {
            sessionManager: {
              getSessionId: () => 'replacement',
              getSessionFile: () => '/new.jsonl'
            }
          }
        )
      }

      await vi.advanceTimersByTimeAsync(60_000)

      expect(harness.fetchMock).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('does not leave an old timer alive when the extension factory reloads', async () => {
    vi.useFakeTimers()
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await park(harness)
    harness.reload()

    await vi.advanceTimersByTimeAsync(60_000)

    expect(harness.fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await park(harness)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['missing-call', 'missing-context', 'ephemeral', 'conflicting-session'])(
    'never arms a repeated status for %s',
    async (reason) => {
      vi.useFakeTimers()
      const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
      const ctx = context()
      if (reason === 'ephemeral') {
        ctx.sessionManager!.getSessionFile = () => undefined
      }
      await harness.callHook(
        'tool_approval_requested',
        {
          ...REQUEST,
          ...(reason === 'missing-call' ? { toolCallId: undefined } : {}),
          ...(reason === 'conflicting-session' ? { sessionId: 'different' } : {})
        },
        reason === 'missing-context' ? undefined : ctx
      )
      await vi.advanceTimersByTimeAsync(0)
      harness.fetchMock.mockClear()

      await vi.advanceTimersByTimeAsync(60_000)

      expect(harness.fetchMock).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
