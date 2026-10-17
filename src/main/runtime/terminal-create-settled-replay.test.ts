import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from './rpc/core'
import { TERMINAL_METHODS } from './rpc/methods/terminal'
import { OrcaRuntimeService } from './omni-runtime'
import { RemoteRuntimeTerminalCreateIdempotency } from './remote-runtime-terminal-create-idempotency'

const method = TERMINAL_METHODS.find((candidate) => candidate.name === 'terminal.create')!

function scenario(clientKind?: RpcContext['clientKind']) {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(
    runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope(selector: string): Promise<unknown>
    },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockImplementation(async (selector) => ({
    id: selector.replace(/^id:/, ''),
    path: '/tmp/replay',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  }))
  const live = new Set<string>()
  const spawn = vi.fn(async (): Promise<{ id: string; incarnationId?: string }> => {
    const id = `worktree-1@@${randomUUID()}`
    live.add(id)
    return { id, incarnationId: randomUUID() }
  })
  const write = vi.fn(() => true)
  runtime.setPtyController({
    spawn,
    write,
    kill: (id: string) => {
      live.delete(id)
      runtime.onPtyExit(id, 0, undefined, { providerExitObserved: true })
      return true
    },
    getForegroundProcess: async () => null
  } as never)
  const mutation = randomUUID()
  const create = (overrides: Record<string, unknown> = {}) =>
    method.handler(
      {
        worktree: 'id:worktree-1',
        clientMutationId: mutation,
        command: 'echo hello',
        ...overrides
      },
      { runtime, clientId: 'device-a', clientKind } as RpcContext,
      vi.fn()
    ) as Promise<{
      terminal: Awaited<ReturnType<OrcaRuntimeService['createTerminal']>>
    }>
  return { runtime, spawn, write, live, mutation, create }
}

afterEach(() => vi.restoreAllMocks())

describe('settled terminal.create RPC replays through the runtime', () => {
  it('returns the same identity four times with exactly one physical spawn', async () => {
    const { create, spawn, live } = scenario()
    const first = await create()
    for (let i = 0; i < 3; i++) {
      expect(await create()).toEqual(first)
    }
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(live.size).toBe(1)
  })

  it('recovers the original PTY handle when an identical request replays during renderer reload', async () => {
    const { runtime, create, spawn, write, live } = scenario()
    runtime.attachWindow(7)
    runtime.markGraphReady(7)
    const first = await create()
    expect(runtime.markRendererReloading(7)).not.toBeNull()
    expect(runtime.resolveLiveLeafForHandle(first.terminal.handle)).toBeNull()
    expect(await create()).toEqual(first)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(live.size).toBe(1)
    expect(runtime.resolveLiveLeafForHandle(first.terminal.handle)?.ptyId).toBe(
      first.terminal.ptyId
    )
    await runtime.sendTerminal(first.terminal.handle, { text: 'probe' })
    expect(write).toHaveBeenLastCalledWith(first.terminal.ptyId, 'probe')
  })

  it('does not adopt a replacement process incarnation under the original PTY id', async () => {
    const { runtime, create, spawn } = scenario()
    runtime.attachWindow(7)
    runtime.markGraphReady(7)
    const first = await create()
    runtime.onPtySpawned(first.terminal.ptyId!, randomUUID(), { awaitsRegistration: false })
    const second = await create()
    expect(second.terminal.ptyId).not.toBe(first.terminal.ptyId)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('proceeds as the base would when reload recovery cannot prove the process incarnation', async () => {
    const { runtime, create, spawn } = scenario()
    spawn.mockResolvedValueOnce({ id: 'worktree-1@@legacy' })
    runtime.attachWindow(7)
    runtime.markGraphReady(7)
    const first = await create()
    runtime.markRendererReloading(7)
    const second = await create()
    expect(second.terminal.ptyId).not.toBe(first.terminal.ptyId)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('creates anew after the original terminal is closed: two lifetime, one live', async () => {
    const { create, runtime, spawn, live } = scenario()
    const first = await create()
    const ptyId = first.terminal.ptyId!
    await runtime.closeTerminal(first.terminal.handle)
    const second = await create()
    expect(second.terminal.ptyId).not.toBe(ptyId)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(live.size).toBe(1)
  })

  it('keeps non-UUID and mobile requests on the base path', async () => {
    const ordinary = scenario()
    await ordinary.create({ clientMutationId: 'create-1' })
    await ordinary.create({ clientMutationId: 'create-1' })
    expect(ordinary.spawn).toHaveBeenCalledTimes(2)
    const mobile = scenario('mobile')
    await mobile.create()
    await mobile.create()
    expect(mobile.spawn).toHaveBeenCalledTimes(2)
  })

  it('treats a changed payload as a new request with its own handle, without refusing', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { create, spawn, live } = scenario()
    const first = await create()
    const second = await create({ command: 'echo different' })
    expect(second.terminal.handle).not.toBe(first.terminal.handle)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(live.size).toBe(2)
    expect(await create({ command: 'echo different' })).toEqual(second)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning.mock.calls.flat().join(' ')).not.toContain('echo')
  })

  it('preserves the base join for concurrent requests, even when payloads differ', async () => {
    const { create, spawn } = scenario()
    let release!: (value: { id: string }) => void
    spawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const first = create()
    const second = create({ command: 'different while pending' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    release({ id: 'worktree-1@@pending' })
    expect(await second).toEqual(await first)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('does not remember failures and allows a successful retry', async () => {
    const { create, spawn } = scenario()
    spawn.mockRejectedValueOnce(new Error('provider unavailable'))
    await expect(create()).rejects.toThrow('provider unavailable')
    await create()
    await create()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('preserves an earlier success when a changed-payload attempt fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { create, spawn, live } = scenario()
    const first = await create()
    spawn.mockRejectedValueOnce(new Error('provider unavailable'))
    await expect(create({ command: 'echo changed' })).rejects.toThrow('provider unavailable')
    expect(await create()).toEqual(first)
    const changed = await create({ command: 'echo changed' })
    expect(changed.terminal.handle).not.toBe(first.terminal.handle)
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(live.size).toBe(2)
  })

  it('drops a receipt whose exact leaf is gone while a sibling leaf still exists', async () => {
    const { create, spawn, runtime } = scenario()
    const first = await create()
    const graph = runtime as unknown as {
      handles: Map<string, { tabId: string; leafId: string }>
      leaves: Map<string, { ptyId: string }>
    }
    const record = graph.handles.get(first.terminal.handle)!
    record.tabId = 'visible-parent'
    record.leafId = 'closed-leaf'
    graph.leaves.set('visible-parent::sibling', { ptyId: first.terminal.ptyId! })
    const second = await create()
    expect(second.terminal.ptyId).not.toBe(first.terminal.ptyId)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('does not replay a receipt after its handle was rebound to a different PTY', async () => {
    const { create, spawn, runtime } = scenario()
    const first = await create()
    const replacement = await create({ clientMutationId: randomUUID() })
    const handles = (runtime as unknown as { handles: Map<string, { ptyId: string }> }).handles
    const record = handles.get(first.terminal.handle)!
    record.ptyId = replacement.terminal.ptyId!
    const second = await create()
    expect(second.terminal.ptyId).not.toBe(first.terminal.ptyId)
    expect(second.terminal.ptyId).not.toBe(replacement.terminal.ptyId)
    expect(spawn).toHaveBeenCalledTimes(3)
  })

  it('shares receipts across canonical selector aliases and object key order', async () => {
    const { create, spawn } = scenario()
    const first = await create({ env: { A: '1', B: '2' } })
    const replay = await create({ worktree: 'worktree-1', env: { B: '2', A: '1' } })
    expect(replay).toEqual(first)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('creates normally after the ten minute receipt window expires', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { create, spawn } = scenario()
    await create()
    await create()
    expect(spawn).toHaveBeenCalledTimes(1)
    now += 600_001
    await create()
    await create({ clientMutationId: randomUUID() })
    expect(spawn).toHaveBeenCalledTimes(3)
  })

  it('keeps 100 distinct logical requests distinct', async () => {
    const { create, spawn, live } = scenario()
    const handles = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const result = await create({ clientMutationId: randomUUID() })
      handles.add(result.terminal.handle)
    }
    expect(spawn).toHaveBeenCalledTimes(100)
    expect(live.size).toBe(100)
    expect(handles.size).toBe(100)
  })

  it('evicts the oldest success after 1024 receipts without affecting active promises', async () => {
    const receipts = new RemoteRuntimeTerminalCreateIdempotency()
    const create = vi.fn(async () => ({ handle: randomUUID(), worktreeId: 'w', title: null }))
    const options = { fingerprint: 'hash', isAlive: () => true }
    let release!: (value: { handle: string; worktreeId: string; title: null }) => void
    const pendingCreate = vi.fn(
      () =>
        new Promise<{ handle: string; worktreeId: string; title: null }>((resolve) => {
          release = resolve
        })
    )
    const pending = receipts.run('c', 'w', 'pending', pendingCreate, options)
    for (let i = 0; i < 1025; i++) {
      await receipts.run('c', 'w', String(i), create, options)
    }
    await receipts.run('c', 'w', '1024', create, options)
    expect(create).toHaveBeenCalledTimes(1025)
    await receipts.run('c', 'w', '0', create, options)
    expect(create).toHaveBeenCalledTimes(1026)
    const duplicate = receipts.run('c', 'w', 'pending', pendingCreate, options)
    expect(duplicate).toBe(pending)
    expect(pendingCreate).toHaveBeenCalledTimes(1)
    const terminal = { handle: 'pending-terminal', worktreeId: 'w', title: null }
    release(terminal)
    expect(await pending).toEqual(terminal)
    expect(await duplicate).toEqual(terminal)
  })
})
