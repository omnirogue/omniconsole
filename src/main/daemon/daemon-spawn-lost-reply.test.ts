import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonClient } from './client'
import type { DaemonPendingRequests } from './daemon-client-pending-requests'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'
import type { RpcContext } from '../runtime/rpc/core'
import { TERMINAL_METHODS } from '../runtime/rpc/methods/terminal'
import { OrcaRuntimeService } from '../runtime/omni-runtime'

let harness: DaemonAdapterHarness | undefined
let adapter: DaemonPtyAdapter | undefined

afterEach(async () => {
  adapter?.dispose()
  await harness?.server.shutdown()
  if (harness) {
    rmSync(harness.dir, { recursive: true, force: true })
  }
  adapter = undefined
  harness = undefined
  vi.restoreAllMocks()
})

describe('a local daemon spawn whose reply is lost', () => {
  it('recovers the one surviving subprocess on same-ID RPC replay without respawning', async () => {
    const subprocess = vi.fn(() => createMockSubprocess())
    harness = await startDaemonAdapterHarness(subprocess)
    const worktreeId = `repo-1::${harness.dir}`
    harness.adapter.dispose()
    const respawn = vi.fn(async () => {})
    adapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath,
      respawn
    })
    const client = (adapter as unknown as { client: DaemonClient }).client
    const pending = (client as unknown as { pendingRequests: DaemonPendingRequests })
      .pendingRequests
    const settle = pending.settle.bind(pending)
    let discardSpawnReply = true
    vi.spyOn(pending, 'settle').mockImplementation((response) => {
      if (
        discardSpawnReply &&
        response.ok &&
        (response.payload as { isNew?: unknown } | null)?.isNew === true
      ) {
        discardSpawnReply = false
        client.disconnect()
        return
      }
      settle(response)
    })

    const runtime = new OrcaRuntimeService()
    vi.spyOn(
      runtime as unknown as {
        resolveTerminalWorkspaceLaunchScope(selector: string): Promise<unknown>
      },
      'resolveTerminalWorkspaceLaunchScope'
    ).mockResolvedValue({
      id: worktreeId,
      path: harness.dir,
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    const spawn = vi.fn(async (options: { preAllocatedHandle?: string }) =>
      adapter!.spawn({
        cols: 80,
        rows: 24,
        worktreeId,
        cwd: harness!.dir,
        env: { ORCA_TERMINAL_HANDLE: options.preAllocatedHandle! }
      })
    )
    const listProcesses = vi.fn(() => adapter!.listProcesses())
    runtime.setPtyController({ spawn, listProcesses } as never)
    const createMethod = TERMINAL_METHODS.find((method) => method.name === 'terminal.create')!
    const clientMutationId = randomUUID()
    const create = () =>
      createMethod.handler(
        { worktree: `id:${worktreeId}`, clientMutationId },
        { runtime, clientId: 'local-person' } as RpcContext,
        vi.fn()
      ) as Promise<{ terminal: { ptyId: string } }>

    const failure = await create().catch((error: unknown) => error)
    const recovered = await create()
    expect((await adapter.listProcesses())[0].id).toBe(recovered.terminal.ptyId)
    expect(subprocess).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(listProcesses).toHaveBeenCalledTimes(1)
    expect(respawn).not.toHaveBeenCalled()
    expect(failure).toMatchObject({ agentSessionOperationOutcome: 'unknown' })
  })
})
