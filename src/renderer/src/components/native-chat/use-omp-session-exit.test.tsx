// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { useOmpSessionExit } from './use-omp-session-exit'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  entry: undefined as AgentStatusEntry | undefined,
  records: {} as Record<string, SleepingAgentSessionRecord>
}))
vi.mock('./request-omp-session-exit', () => ({ requestOmpSessionExit: mocks.request }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      agentStatusByPaneKey: { 'tab:leaf': mocks.entry },
      sleepingAgentSessionsByPaneKey: mocks.records
    })
  }
}))

const target = {
  agent: 'omp',
  tabId: 'tab',
  paneKey: 'tab:leaf',
  ptyId: 'pty-a',
  sessionId: 'native-a',
  runtimeEnvironmentId: null,
  connectionId: null,
  agentExited: false
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.entry = {
    agentType: 'omp',
    paneKey: target.paneKey,
    worktreeId: 'work-a',
    state: 'done',
    prompt: '',
    updatedAt: 10,
    stateStartedAt: 10,
    stateHistory: [],
    providerSession: { key: 'session_id', id: 'native-a' },
    connectionId: null
  }
  mocks.records = {}
})
afterEach(cleanup)

it('keeps a duplicate click to one request and never treats acknowledgement as exit', async () => {
  let resolve!: () => void
  mocks.request.mockImplementation(({ assertCurrent }) => {
    assertCurrent()
    return new Promise<void>((done) => {
      resolve = done
    })
  })
  const { result } = renderHook(() => useOmpSessionExit(target))
  let pending!: Promise<void>
  act(() => {
    pending = result.current.end()
    void result.current.end()
  })
  expect(result.current.phase).toBe('pending')
  expect(mocks.request).toHaveBeenCalledTimes(1)
  await act(async () => {
    resolve()
    await pending
  })
  expect(result.current.phase).toBe('requested')
  await act(() => result.current.end())
  expect(mocks.request).toHaveBeenCalledTimes(1)
})

it.each(['session', 'host', 'pty', 'connection'])(
  'ignores an acknowledgement after the %s changes',
  async (change) => {
    let resolve!: () => void
    mocks.request.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const { result, rerender } = renderHook((props) => useOmpSessionExit(props), {
      initialProps: {
        ...target,
        runtimeEnvironmentId: null as string | null,
        connectionId: null as string | null
      }
    })
    let pending!: Promise<void>
    act(() => {
      pending = result.current.end()
    })
    rerender({
      ...target,
      ...(change === 'session' ? { sessionId: 'native-b' } : {}),
      ...(change === 'host' ? { runtimeEnvironmentId: 'peer-b' } : {}),
      ...(change === 'pty' ? { ptyId: 'pty-b' } : {}),
      ...(change === 'connection' ? { connectionId: 'ssh-b' } : {})
    })
    await act(async () => {
      resolve()
      await pending
    })
    expect(result.current.phase).toBeUndefined()
    expect(result.current.requested).toBe(false)
  }
)

it('keeps a lost connection unverified and does not retry', async () => {
  mocks.request.mockRejectedValue(new Error('execution host disconnected'))
  const { result } = renderHook(() => useOmpSessionExit(target))
  await act(() => result.current.end())
  expect(result.current.phase).toBe('unverified')
  expect(result.current.error).toBe('execution host disconnected')
  await act(() => result.current.end())
  expect(mocks.request).toHaveBeenCalledTimes(1)
})

it('rejects a stale native session before the client can send', async () => {
  mocks.entry!.providerSession = { key: 'session_id', id: 'native-b' }
  mocks.request.mockImplementation(async ({ assertCurrent }) => assertCurrent())
  const { result } = renderHook(() => useOmpSessionExit(target))
  await act(() => result.current.end())
  expect(result.current.phase).toBe('unverified')
  expect(result.current.error).toContain('conversation changed')
})

function retainOmpIdentity() {
  mocks.entry!.providerSession = undefined
  mocks.records[target.paneKey] = {
    paneKey: target.paneKey,
    tabId: target.tabId,
    worktreeId: 'work-a',
    agent: 'omp',
    providerSession: { key: 'session_id', id: 'native-a' },
    prompt: '',
    state: 'done',
    capturedAt: 10,
    updatedAt: 10,
    origin: 'live'
  }
  mocks.request.mockImplementation(async ({ assertCurrent }) => assertCurrent())
}

it('uses the same pane identity as Chat when terminal status omits it', async () => {
  retainOmpIdentity()
  const { result } = renderHook(() =>
    useOmpSessionExit({ ...target, runtimeEnvironmentId: 'peer-a' })
  )
  await act(() => result.current.end())
  expect(result.current.phase).toBe('requested')
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sessionId: 'native-a', runtimeEnvironmentId: 'peer-a' })
  )
})

it.each(['pane', 'tab', 'workspace', 'agent', 'connection', 'session', 'missing'])(
  'rejects a retained identity with a %s mismatch',
  async (mismatch) => {
    retainOmpIdentity()
    const record = mocks.records[target.paneKey]!
    if (mismatch === 'pane') {
      record.paneKey = 'other:leaf'
    }
    if (mismatch === 'tab') {
      record.tabId = 'other'
    }
    if (mismatch === 'workspace') {
      record.worktreeId = 'work-b'
    }
    if (mismatch === 'agent') {
      record.agent = 'claude'
    }
    if (mismatch === 'connection') {
      record.connectionId = 'ssh-b'
    }
    if (mismatch === 'session') {
      record.providerSession.id = 'native-b'
    }
    if (mismatch === 'missing') {
      mocks.records = {}
    }
    const { result } = renderHook(() => useOmpSessionExit(target))
    await act(() => result.current.end())
    expect(result.current.phase).toBe('unverified')
    expect(result.current.error).toContain('conversation changed')
  }
)

it('does not hide a newer live native session behind its retained identity', async () => {
  retainOmpIdentity()
  mocks.entry!.providerSession = { key: 'session_id', id: 'native-b' }
  const { result } = renderHook(() => useOmpSessionExit(target))
  await act(() => result.current.end())
  expect(result.current.phase).toBe('unverified')
})

it('rechecks the retained identity before accepting the host acknowledgement', async () => {
  retainOmpIdentity()
  mocks.request.mockImplementation(async ({ assertCurrent }) => {
    assertCurrent()
    mocks.records[target.paneKey]!.providerSession.id = 'native-b'
  })
  const { result } = renderHook(() => useOmpSessionExit(target))
  await act(() => result.current.end())
  expect(result.current.phase).toBe('unverified')
})
