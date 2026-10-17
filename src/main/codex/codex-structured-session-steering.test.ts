import { describe, expect, it, vi } from 'vitest'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'
import type { CodexAppServerConnectionHandlers } from './codex-app-server-connection'
import { identityFor, THREAD_ID, USER_MESSAGE } from './codex-structured-session-adapter.fixtures'

async function harness(completesBeforeStartAck = false) {
  let handlers: CodexAppServerConnectionHandlers = {}
  const request = vi.fn(async (method: string) => {
    if (method === 'thread/start') {
      return { thread: { id: THREAD_ID }, model: 'original', reasoningEffort: 'high' }
    }
    if (method === 'turn/start') {
      if (completesBeforeStartAck) {
        handlers.onNotification?.('turn/completed', {
          threadId: THREAD_ID,
          turn: { id: 'turn', status: 'completed' }
        })
      }
      return { turn: { id: 'turn' } }
    }
    if (method === 'turn/steer') {
      return { turnId: 'turn' }
    }
    if (method === 'model/list') {
      return {
        data: ['original', 'next'].map((id) => ({
          id,
          model: id,
          supportedReasoningEfforts: [{ reasoningEffort: 'high' }]
        }))
      }
    }
    return {}
  })
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work',
      codexHome: null,
      resumeThreadId: null
    }),
    openConnection: async (_launch, nextHandlers) => {
      handlers = nextHandlers ?? {}
      return {
        pid: 123,
        closed: false,
        request,
        notify: vi.fn(),
        respond: vi.fn(),
        respondWithError: vi.fn(),
        close: async () => true
      }
    },
    readProcessStartTime: async () => 100,
    captureTurnProcesses: async () => ({ platform: 'win32', identities: new Map() }),
    terminateTurnProcesses: async () => true
  })
  await adapter.acquire({ identity: identityFor('session'), fence: 1, spawnToken: 'spawn' })
  const send = (clientMessageId: string) =>
    adapter.dispatch({ sessionId: 'session', clientMessageId, body: USER_MESSAGE, fence: 1 })
  return { adapter, request, send }
}

describe('Codex adapter steering routing', () => {
  it('uses turn/steer while busy, preserves active source options', async () => {
    const { adapter, request, send } = await harness()
    await send('original')
    await adapter.setOption({ sessionId: 'session', fence: 1, key: 'model', value: 'next' })
    expect(await send('correction')).toEqual({
      state: 'accepted',
      providerIdentity: { provider: 'omni', clientMessageId: 'correction' }
    })
    expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
    expect(request.mock.calls.filter(([method]) => method === 'turn/steer')).toHaveLength(1)
    expect(
      await adapter.readSourceOptions({
        sessionId: 'session',
        fence: 1,
        clientMessageId: 'correction'
      })
    ).toEqual({ model: 'original', effort: 'high' })
    await adapter.closeAll()
  })
  it('does not resurrect a completed turn when its start receipt arrives late', async () => {
    const { adapter, request, send } = await harness(true)
    await send('first')
    await send('second')
    expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(2)
    expect(request.mock.calls.filter(([method]) => method === 'turn/steer')).toHaveLength(0)
    await adapter.closeAll()
  })
})
