import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../omni-runtime'
import type { RpcContext } from '../../core'
import { END_OMP_SESSION_METHOD as method } from './terminal-end-omp-session'

const schema = (() => {
  if (!method.params) {
    throw new Error('End OMP session must have an exact-owner schema.')
  }
  return method.params
})()

const params = {
  paneKey: 'tab:leaf',
  worktreeId: 'folder:/workspace',
  expectedPtyId: 'pty-a',
  expectedProviderSessionId: 'native-a',
  expectedExecutionRuntimeId: 'runtime-a'
}

function harness(context: Partial<RpcContext> = {}) {
  const state = {
    ptyId: 'pty-a',
    nativeId: 'native-a',
    incarnation: 'inc-a',
    foreground: 'omp',
    connected: true,
    connectionId: null as string | null,
    wslDistro: null as string | null,
    activeDispatch: null as object | null
  }
  const written: string[] = []
  const inspect = vi.fn(async () => ({
    foregroundProcess: state.foreground,
    hasChildProcesses: true
  }))
  const send = vi.fn(
    async (
      _handle: string,
      action: { text: string },
      options: {
        beforeWrite: (ptyId: string) => Promise<void>
        reserveWrite: (ptyId: string) => void
      }
    ) => {
      await options.beforeWrite(state.ptyId)
      options.reserveWrite(state.ptyId)
      written.push(action.text)
      return { accepted: true }
    }
  )
  const runtime = {
    getRuntimeId: () => 'runtime-a',
    getSessionOutcomeExecutionScope: async () => ({
      path: '/workspace',
      connectionId: state.connectionId,
      wslDistro: state.wslDistro
    }),
    resolveTerminalPane: () => ({
      handle: 'term-a',
      ptyId: state.ptyId,
      worktreeId: params.worktreeId,
      connected: state.connected
    }),
    getTerminalProcessIncarnation: () => state.incarnation,
    getSessionOutcomeTranscriptSource: () => ({
      kind: 'provider',
      hostId: 'local',
      agent: 'omp',
      sessionId: state.nativeId
    }),
    getOrchestrationDb: () => ({ getActiveDispatchForTerminal: () => state.activeDispatch }),
    inspectTerminalProcess: inspect,
    cancelSessionInput: vi.fn(),
    sendTerminal: send
  } as unknown as OrcaRuntimeService
  const ctx = { runtime, clientId: 'desktop-renderer', ...context }
  return {
    state,
    written,
    inspect,
    send,
    runtime,
    call: (input = params) => method.handler(schema.parse(input), ctx)
  }
}

it.each(['local', 'paired'])(
  'requests one native exit on the %s owner without claiming completion',
  async (owner) => {
    const h = harness(
      owner === 'paired'
        ? { clientId: undefined, clientKind: 'runtime', pairedDeviceId: 'device-a' }
        : {}
    )
    const result = await Promise.all([h.call(), h.call()])
    expect(result).toEqual([{ requested: true }, { requested: true }])
    expect(h.written).toEqual(['\x04'])
    expect(h.runtime.cancelSessionInput).toHaveBeenCalledExactlyOnceWith('pty-a')
    expect(await h.call()).toEqual({ requested: true })
    expect(h.written).toHaveLength(1)
  }
)

it.each([
  'native',
  'pty',
  'offline',
  'runtime',
  'ssh',
  'wsl',
  'worker',
  'shell',
  'different-agent'
])('refuses %s ownership before writing', async (change) => {
  const h = harness()
  if (change === 'native') {
    h.state.nativeId = 'sibling'
  }
  if (change === 'pty') {
    h.state.ptyId = 'sibling'
  }
  if (change === 'offline') {
    h.state.connected = false
  }
  if (change === 'ssh') {
    h.state.connectionId = 'ssh-a'
  }
  if (change === 'wsl') {
    h.state.wslDistro = 'Ubuntu'
  }
  if (change === 'worker') {
    h.state.activeDispatch = {}
  }
  if (change === 'shell') {
    h.state.foreground = 'zsh'
  }
  if (change === 'different-agent') {
    h.state.foreground = 'claude'
  }
  await expect(
    h.call(change === 'runtime' ? { ...params, expectedExecutionRuntimeId: 'runtime-b' } : params)
  ).rejects.toThrow()
  expect(h.written).toEqual([])
})

it.each(['anonymous', 'agent', 'unpaired'])(
  'rejects the %s caller before resolving execution',
  async (caller) => {
    const h = harness(
      caller === 'agent'
        ? { orchestrationCapability: 'agent-token' }
        : {
            clientId: undefined,
            ...(caller === 'unpaired' ? { clientKind: 'runtime' as const } : {})
          }
    )
    await expect(h.call()).rejects.toThrow('authenticated user interface')
    expect(h.inspect).not.toHaveBeenCalled()
    expect(h.written).toEqual([])
  }
)

it.each(['native', 'incarnation', 'pty'])(
  'rechecks %s after asynchronous foreground evidence',
  async (change) => {
    const h = harness()
    h.inspect.mockImplementationOnce(async () => {
      if (change === 'native') {
        h.state.nativeId = 'native-b'
      }
      if (change === 'incarnation') {
        h.state.incarnation = 'inc-b'
      }
      if (change === 'pty') {
        h.state.ptyId = 'pty-b'
      }
      return { foregroundProcess: 'omp', hasChildProcesses: true }
    })
    await expect(h.call()).rejects.toThrow('owner changed')
    expect(h.written).toEqual([])
  }
)

it('checks the binding again synchronously at the final write', async () => {
  const h = harness()
  h.send.mockImplementationOnce(async (_handle, _action, options) => {
    await options.beforeWrite('pty-a')
    h.state.incarnation = 'inc-b'
    options.reserveWrite('pty-a')
    throw new Error('must not reach the write')
  })
  await expect(h.call()).rejects.toThrow('owner changed')
  expect(h.written).toEqual([])
})

it('does not replay a write whose acknowledgement was lost', async () => {
  const h = harness()
  h.send.mockImplementationOnce(async (_handle, action, options) => {
    await options.beforeWrite('pty-a')
    options.reserveWrite('pty-a')
    h.written.push(action.text)
    throw new Error('connection lost after write')
  })
  await expect(h.call()).rejects.toThrow('connection lost')
  await expect(h.call()).rejects.toThrow('connection lost')
  expect(h.written).toEqual(['\x04'])
})

it('refuses an aborted request and accepts no arbitrary command payload', async () => {
  const controller = new AbortController()
  const h = harness({ signal: controller.signal })
  controller.abort()
  await expect(h.call()).rejects.toThrow('cancelled')
  expect(h.written).toEqual([])
  expect(() => schema.parse({ ...params, text: 'anything' })).toThrow()
})
