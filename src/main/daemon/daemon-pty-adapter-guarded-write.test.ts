/* A guarded write (`guarded-pty-write.ts`) over the real daemon socket: the receiver reaches the
 * session's own PTY, which alone decides; a PTY that cannot check, or no session, never writes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import {
  closeWriteFence,
  isWriteFenceOpen,
  openWriteFence,
  registerWriteFenceInvalidator
} from '../runtime/conversation-write-fence'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { GuardedWriteCheck } from '../pty/guarded-pty-write'
import type * as DaemonHealthModule from './daemon-health'
import type * as DaemonTccAttributionModule from './daemon-tcc-attribution'
import type * as DaemonBundleStalenessModule from './daemon-bundle-staleness'

vi.mock('./daemon-health', async (importOriginal) => ({
  ...(await importOriginal<typeof DaemonHealthModule>()),
  getMacDaemonSystemResolverHealth: vi.fn(async () => 'unknown')
}))
vi.mock('./daemon-tcc-attribution', async (importOriginal) => ({
  ...(await importOriginal<typeof DaemonTccAttributionModule>()),
  getMacDaemonTccAttributionHealth: vi.fn(async () => 'unknown')
}))
vi.mock('./daemon-bundle-staleness', async (importOriginal) => ({
  ...(await importOriginal<typeof DaemonBundleStalenessModule>()),
  isDaemonStaleForCurrentBundle: vi.fn(async () => false)
}))

const RECEIVER = { pid: 4242, pgid: 4242, startTimeMs: 1_000_000 }

describe('DaemonPtyAdapter.guardedWrite', () => {
  let dir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let guard: SubprocessHandle['guardedWrite']
  let subprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    guard = undefined
    const harness = await startDaemonAdapterHarness(() => {
      subprocess = createMockSubprocess()
      return guard ? { ...subprocess, guardedWrite: guard } : subprocess
    })
    ;({ dir, server, adapter } = harness)
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('carries the receiver to the session’s PTY and reports what it decided', async () => {
    const decide = vi.fn((data: string, { receiver }: GuardedWriteCheck) => {
      if (receiver.pgid !== 4242) {
        return 'refused' as const
      }
      subprocess.write(data)
      return 'written' as const
    })
    guard = decide
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    await expect(adapter.guardedWrite(id, 'Run the tests.', RECEIVER)).resolves.toBe('written')
    expect(decide).toHaveBeenCalledWith('Run the tests.', { receiver: RECEIVER })
    expect(subprocess.write).toHaveBeenCalledWith('Run the tests.')
    await expect(adapter.guardedWrite(id, 'x', { ...RECEIVER, pgid: 5000 })).resolves.toBe(
      'refused'
    )
  })

  it('never writes through a PTY that cannot check, or to a session it does not have', async () => {
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    await expect(adapter.guardedWrite(id, 'Run the tests.', RECEIVER)).resolves.toBe('unsupported')
    expect(subprocess.write).not.toHaveBeenCalledWith('Run the tests.')
    await expect(adapter.guardedWrite('no-such-session', 'x', RECEIVER)).resolves.toBe('refused')
  })

  it('checks cancellation of an already queued Enter at the daemon, without a revoke RPC', async () => {
    guard = (data, check) => {
      if (check.fenceRevoked?.()) {
        return 'revoked'
      }
      subprocess.write(data)
      return 'written'
    }
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    const token = openWriteFence({ kind: 'pty', worktreeId: 'wt', paneKey: 'pane' }, () => true)
    const fence = {
      token,
      isRevoked: () => !isWriteFenceOpen(token),
      onClose: (invalidate: () => void) => registerWriteFenceInvalidator(token, invalidate)
    }
    await expect(adapter.guardedWrite(id, 'Run the tests.', RECEIVER, fence)).resolves.toBe(
      'written'
    )
    const client = Reflect.get(adapter, 'client') as {
      request: (type: string, payload: unknown) => Promise<unknown>
    }
    const original = client.request.bind(client)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const request = vi.spyOn(client, 'request').mockImplementation(async (type, payload) => {
      await held
      return original(type, payload)
    })
    const enter = adapter.guardedWrite(id, '\r', RECEIVER, fence)
    closeWriteFence(token)
    release()
    await expect(enter).resolves.toBe('revoked')
    expect(subprocess.write).not.toHaveBeenCalledWith('\r')
    request.mockRestore()
  })

  it('reports a lost reply as unknown, never a proven refusal that permits a retry', async () => {
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    const client = Reflect.get(adapter, 'client') as { request: (type: string) => Promise<unknown> }
    const request = vi.spyOn(client, 'request').mockRejectedValue(new Error('Connection lost'))
    await expect(adapter.guardedWrite(id, 'x', RECEIVER)).resolves.toBe('unknown')
    request.mockRestore()
  })

  it('treats a daemon that knows no fences as unsupported: nothing fenced is written', async () => {
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    const client = Reflect.get(adapter, 'client') as { request: (type: string) => Promise<unknown> }
    const request = vi.spyOn(client, 'request').mockImplementation(async (type: string) => {
      throw new Error(`Unknown request type: ${type}`)
    })
    const fence = { token: 'fence-old-daemon', isRevoked: () => false, onClose: () => () => {} }
    await expect(adapter.guardedWrite(id, 'x', RECEIVER, fence)).resolves.toBe('unsupported')
    adapter.revokeWriteFence(fence.token)
    await new Promise((resolve) => setTimeout(resolve, 0))
    request.mockClear()
    await expect(adapter.guardedWrite(id, 'x', RECEIVER, fence)).resolves.toBe('unsupported')
    expect(request).not.toHaveBeenCalled()
    request.mockRestore()
  })
})
