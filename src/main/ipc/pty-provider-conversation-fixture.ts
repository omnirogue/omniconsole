import { vi } from 'vitest'
import { classifyErrorMock } from './pty-ipc-mock-registry'
import type { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { OrcaRuntimeService } from '../runtime/omni-runtime'
import { setLocalPtyProvider } from './pty'
import type { PtySpawnOptions, PtySpawnResult } from '../providers/types'

/** One resumable Claude conversation per setup, launched through the real renderer and runtime pipelines. */
export function createProviderConversationFixture(suite: ReturnType<typeof setupPtyIpcSuite>) {
  const { handlers, mainWindowIpcEvent, createAgentClaimProvider, registerAgentClaimController } =
    suite
  let sequence = 0
  function setup(runtimeOverrides: Record<string, unknown> = {}) {
    classifyErrorMock.mockReturnValue({ error_class: 'unknown', retryable: false })
    const conversation = `conversation-${++sequence}`
    const live = new Set<string>()
    const exits: ((event: { id: string; code: number; incarnationId?: string }) => void)[] = []
    const spawn = vi.fn(async (options: PtySpawnOptions): Promise<PtySpawnResult> => {
      if (options.sessionId && live.has(options.sessionId)) {
        return { id: options.sessionId, isReattach: true }
      }
      const id = `process-${conversation}-${spawn.mock.calls.length}`
      live.add(id)
      return { id, incarnationId: `incarnation-${id}` }
    })
    const provider = createAgentClaimProvider({
      livePtyIds: live,
      spawn,
      authoritativeOwnerListings: false
    })
    provider.onExit.mockImplementation((callback) => {
      exits.push(callback)
      return () => {
        const index = exits.indexOf(callback)
        if (index !== -1) {
          exits.splice(index, 1)
        }
      }
    })
    provider.listProcesses.mockImplementation(async () =>
      [...live].map((id) => ({
        id,
        incarnationId: `incarnation-${id}`
      }))
    )
    setLocalPtyProvider(provider as never)
    const controller = registerAgentClaimController({ onPtyExit: vi.fn(), ...runtimeOverrides })
    const args = {
      cols: 80,
      rows: 24,
      launchAgent: 'claude',
      command: `claude --resume ${conversation}`,
      resumeProviderSession: { key: 'session_id', id: conversation }
    }
    const ipc = (overrides: Record<string, unknown> = {}) =>
      handlers.get('pty:spawn')!(mainWindowIpcEvent, { ...args, ...overrides }) as Promise<{
        id: string
      }>
    return { conversation, live, exits, spawn, provider, controller, args, ipc }
  }

  const settings = () => ({
    disabledTuiAgents: [],
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {}
  })

  function setupRuntime(
    h: ReturnType<typeof setup>,
    controller = h.controller,
    store: Record<string, unknown> = { getSettings: settings }
  ) {
    const runtime = new OrcaRuntimeService(store as never, undefined, {
      getLocalProvider: () => h.provider as never
    })
    const internal = runtime as unknown as Record<string, unknown>
    internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
      id: 'workspace',
      path: '/tmp/workspace',
      connectionId: null
    }))
    internal.executionOwnerSupportsAgentSessionOperation = vi.fn(async () => true)
    internal.markLocalWorkspaceTrustedForAgent = vi.fn()
    runtime.setPtyController({
      ...controller,
      // Why: this harness has no persistence store; exercise the real launch and commit paths.
      spawn: (options: Record<string, unknown>) =>
        controller.spawn({ ...options, persistHostSessionBinding: false })
    } as never)
    const create = vi.spyOn(runtime, 'createTerminal')
    return { runtime, create }
  }

  return { setup, setupRuntime, settings }
}
