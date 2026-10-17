import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('./structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: mocks.subscribe
}))
vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: vi.fn(async () => true)
}))
vi.mock('./runtime-environment-revision', () => ({ getRuntimeEnvironmentRevision: () => 1 }))
import { observeStructuredViewerProcess } from './structured-agent-viewer-hold'
import { resetStructuredAgentSessionStatusFeedsForTests } from './structured-agent-session-status-feed'

const target = { kind: 'environment', environmentId: 'owner' } as const
const streams: {
  event: (event: AgentSessionStatusEvent) => void
  error: (error: unknown) => void
  close: () => void
}[] = []
const summary: AgentSessionStatusSummary = {
  sessionId: 'session',
  workspaceId: 'workspace',
  agent: 'codex',
  status: 'working',
  latestPrompt: 'saved history',
  updatedAt: 1,
  processState: 'live',
  hostExecutionOwned: true
}

beforeEach(() => {
  vi.useFakeTimers()
  resetStructuredAgentSessionStatusFeedsForTests()
  streams.length = 0
  mocks.subscribe.mockImplementation((_target, event, error, close) => {
    streams.push({ event, error, close })
    return Promise.resolve({ unsubscribe: vi.fn() })
  })
})
afterEach(() => {
  resetStructuredAgentSessionStatusFeedsForTests()
  vi.useRealTimers()
})

it.each(['error', 'close', 'end', 'empty'] as const)(
  'revokes cold hold proof on %s without a cached row and waits for fresh host evidence',
  async (failure) => {
    for (const heldState of ['live', 'exited'] as const) {
      resetStructuredAgentSessionStatusFeedsForTests()
      streams.length = 0
      let state: 'live' | 'exited' | 'unverifiable' = heldState
      const stop = observeStructuredViewerProcess(target, 'session', (value) => {
        state = value
      })
      await vi.advanceTimersByTimeAsync(0)
      const first = streams[0]!
      if (failure === 'error') {
        first.error(new Error('host disconnected'))
      }
      if (failure === 'close') {
        first.close()
      }
      if (failure === 'end') {
        first.event({ type: 'end' })
      }
      if (failure === 'empty') {
        first.event({ type: 'snapshot', sessions: [] })
      }
      expect(state).toBe('unverifiable')
      if (failure !== 'empty') {
        first.event({ type: 'status', session: summary })
        expect(state).toBe('unverifiable')
        await vi.advanceTimersByTimeAsync(250)
      }
      const fresh = streams.at(-1)!
      fresh.event({ type: 'status', session: summary })
      expect(state).toBe('live')
      fresh.event({ type: 'status', session: { ...summary, processState: 'exited' } })
      expect(state).toBe('exited')
      stop()
    }
  }
)

it('revokes warm proof and retains history through a failed reconnect', async () => {
  const changes = vi.fn()
  const stop = observeStructuredViewerProcess(target, 'session', changes)
  await vi.advanceTimersByTimeAsync(0)
  streams[0]!.event({ type: 'snapshot', sessions: [summary] })
  streams[0]!.error(new Error('offline'))
  expect(changes).toHaveBeenLastCalledWith('unverifiable')
  await vi.advanceTimersByTimeAsync(250)
  streams[1]!.event({ type: 'snapshot', sessions: [] })
  expect(changes).toHaveBeenLastCalledWith('unverifiable')
  streams[1]!.event({ type: 'status', session: summary })
  expect(changes).toHaveBeenLastCalledWith('live')
  stop()
})
