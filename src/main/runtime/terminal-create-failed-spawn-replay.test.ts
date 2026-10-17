import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyProcessInfo } from '../providers/types'
import type { RpcContext } from './rpc/core'
import { TERMINAL_METHODS } from './rpc/methods/terminal'
import { OrcaRuntimeService } from './omni-runtime'

const method = TERMINAL_METHODS.find((candidate) => candidate.name === 'terminal.create')!

function scenario(connectionId: string | null = null) {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(
    runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope(selector: string): Promise<unknown>
    },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockImplementation(async (selector) => ({
    id: selector.replace(/^id:/, ''),
    path: '/tmp/failed-create',
    connectionId,
    repo: null,
    folderWorkspace: null
  }))
  const sessions: PtyProcessInfo[] = []
  const spawn = vi.fn(async (options: { preAllocatedHandle?: string }) => {
    const id = connectionId
      ? `ssh:${connectionId}@@pty-${randomUUID()}`
      : `worktree-1@@${randomUUID()}`
    const incarnationId = randomUUID()
    sessions.push({
      id,
      incarnationId,
      cwd: '/tmp/failed-create',
      title: 'shell',
      worktreeId: 'worktree-1',
      terminalHandle: options.preAllocatedHandle
    })
    return { id, incarnationId }
  })
  const listProcesses = vi.fn(async () => sessions)
  runtime.setPtyController({ spawn, listProcesses } as never)
  const registration = vi.spyOn(
    runtime as unknown as {
      assertPtyDidNotExitBeforeRegistration(id: string, incarnationId?: string): void
    },
    'assertPtyDidNotExitBeforeRegistration'
  )
  registration.mockImplementationOnce(() => {
    throw new Error('registration unavailable after spawn')
  })
  const mutation = randomUUID()
  const create = (overrides: Record<string, unknown> = {}) =>
    method.handler(
      {
        worktree: 'id:worktree-1',
        clientMutationId: mutation,
        command: 'echo hello',
        ...overrides
      },
      { runtime, clientId: 'device-a' } as RpcContext,
      vi.fn()
    ) as Promise<{ terminal: Awaited<ReturnType<OrcaRuntimeService['createTerminal']>> }>
  return { runtime, create, spawn, sessions, listProcesses, registration }
}

afterEach(() => vi.restoreAllMocks())

describe('terminal.create retries after a failed spawn receipt', () => {
  it('adopts the process that survived failed registration instead of spawning another', async () => {
    const { create, spawn, sessions, listProcesses } = scenario()
    await expect(create()).rejects.toThrow('registration unavailable after spawn')
    const recovered = await create()
    expect(recovered.terminal.ptyId).toBe(sessions[0].id)
    expect(recovered.terminal.handle).toBe(sessions[0].terminalHandle)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(sessions).toHaveLength(1)
    expect(listProcesses).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('keeps the failed attempt fenced while the execution host inventory is unavailable', async () => {
    const { create, spawn, sessions, listProcesses } = scenario()
    await expect(create()).rejects.toThrow('registration unavailable after spawn')
    listProcesses.mockRejectedValueOnce(new Error('host disconnected'))
    await expect(create()).rejects.toThrow('runtime_unavailable')
    expect(spawn).toHaveBeenCalledTimes(1)
    const recovered = await create()
    expect(recovered.terminal.ptyId).toBe(sessions[0].id)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('permits startup again after the execution host positively reports the process absent', async () => {
    const { create, spawn, sessions, listProcesses } = scenario()
    await expect(create()).rejects.toThrow('registration unavailable after spawn')
    sessions.splice(0)
    const recovered = await create()
    expect(recovered.terminal.ptyId).toBe(sessions[0].id)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(sessions).toHaveLength(1)
    expect(listProcesses).toHaveBeenCalledTimes(1)
  })

  it('keeps startup retryable when the provider rejects before creating a process', async () => {
    const { create, spawn, registration, sessions, listProcesses } = scenario()
    registration.mockReset()
    spawn.mockRejectedValueOnce(new Error('provider unavailable before spawn'))
    await expect(create()).rejects.toThrow('provider unavailable before spawn')
    await create()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(sessions).toHaveLength(1)
    expect(listProcesses).not.toHaveBeenCalled()
  })

  it('recovers a lost SSH spawn reply using only the owning execution host inventory', async () => {
    const { create, spawn, registration, sessions, listProcesses } = scenario('ssh-owner')
    registration.mockReset()
    const physicalSpawn = spawn.getMockImplementation()!
    spawn.mockImplementationOnce(async (options) => {
      await physicalSpawn(options)
      throw new Error('relay reply lost')
    })
    await expect(create()).rejects.toThrow('relay reply lost')
    const recovered = await create()
    expect(recovered.terminal.ptyId).toBe(sessions[0].id)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(listProcesses).toHaveBeenCalledExactlyOnceWith('ssh-owner')
  })

  it('keeps a recovered receipt across renderer reload without creating a replacement', async () => {
    const { create, spawn, runtime, sessions } = scenario()
    await expect(create()).rejects.toThrow('registration unavailable after spawn')
    const recovered = await create()
    runtime.attachWindow(7)
    runtime.markGraphReady(7)
    runtime.markRendererReloading(7)
    expect(await create()).toEqual(recovered)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(sessions).toHaveLength(1)
  })

  it('keeps recovery tied to the changed payload original process identity', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { create, spawn, registration, sessions } = scenario()
    registration.mockReset()
    const first = await create()
    registration.mockImplementationOnce(() => {
      throw new Error('second registration unavailable')
    })
    await expect(create({ command: 'echo changed' })).rejects.toThrow(
      'second registration unavailable'
    )
    await expect(create()).rejects.toThrow('terminal_create_identity_conflict')
    const recovered = await create({ command: 'echo changed' })
    expect(recovered.terminal.ptyId).toBe(sessions[1].id)
    expect(recovered.terminal.handle).not.toBe(first.terminal.handle)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('joins concurrent recovery requests around a single host inventory read', async () => {
    const { create, spawn, sessions, listProcesses } = scenario()
    await expect(create()).rejects.toThrow('registration unavailable after spawn')
    let releaseInventory!: (sessions: PtyProcessInfo[]) => void
    listProcesses.mockImplementationOnce(
      () => new Promise((resolve) => (releaseInventory = resolve))
    )
    const first = create()
    const second = create()
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(1))
    releaseInventory(sessions)
    expect(await second).toEqual(await first)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('does not treat a legacy process missing its handle as evidence of absence', async () => {
    const { create, spawn, sessions } = scenario()
    await expect(create()).rejects.toThrow('registration unavailable after spawn')
    const handle = sessions[0].terminalHandle
    delete sessions[0].terminalHandle
    await expect(create()).rejects.toThrow('runtime_unavailable')
    expect(spawn).toHaveBeenCalledTimes(1)
    sessions[0].terminalHandle = handle
    expect((await create()).terminal.ptyId).toBe(sessions[0].id)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('holds a retry until an identity-less retained SSH process can be identified', async () => {
    const { create, spawn, sessions, listProcesses } = scenario('ssh-owner')
    await expect(create()).rejects.toThrow('registration unavailable after spawn')
    const { terminalHandle, worktreeId } = sessions[0]
    delete sessions[0].terminalHandle
    delete sessions[0].worktreeId
    await expect(create()).rejects.toThrow('runtime_unavailable')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(listProcesses).toHaveBeenCalledExactlyOnceWith('ssh-owner')
    Object.assign(sessions[0], { terminalHandle, worktreeId })
    const recovered = await create()
    expect(recovered.terminal.ptyId).toBe(sessions[0].id)
    expect(recovered.terminal.handle).toBe(terminalHandle)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('releases the old failure fence after authoritative absence and a prebirth retry rejection', async () => {
    const { create, spawn, sessions, listProcesses } = scenario()
    await expect(create()).rejects.toThrow('registration unavailable after spawn')
    sessions.splice(0)
    spawn.mockRejectedValueOnce(new Error('provider unavailable before spawn'))
    await expect(create()).rejects.toThrow('provider unavailable before spawn')
    await create()
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(sessions).toHaveLength(1)
    expect(listProcesses).toHaveBeenCalledTimes(1)
  })

  it('recovers a reused stable owner without treating its lost registration as a new birth', async () => {
    const { create, spawn, sessions } = scenario()
    const tabId = randomUUID()
    const leafId = randomUUID()
    const incarnationId = randomUUID()
    const existingOwner = {
      id: `worktree-1@@${randomUUID()}`,
      incarnationId,
      cwd: '/tmp/failed-create',
      title: 'Existing worker',
      worktreeId: 'worktree-1',
      terminalHandle: `term_${randomUUID()}`
    }
    sessions.push(existingOwner)
    spawn.mockImplementationOnce(async () => ({
      id: existingOwner.id,
      incarnationId,
      stablePaneOwner: { handle: existingOwner.terminalHandle, tabId, leafId }
    }))
    await expect(create()).rejects.toMatchObject({
      message: 'registration unavailable after spawn',
      agentSessionOperationOutcome: 'unknown'
    })
    const recovered = await create()
    expect(recovered.terminal.handle).toBe(existingOwner.terminalHandle)
    expect(recovered.terminal.ptyId).toBe(existingOwner.id)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(sessions).toHaveLength(1)
  })
})
