import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../omni-runtime'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'
import * as capture from '../../pty-descendant-termination'
import {
  captureWorkerReleaseProcessTree,
  readWorkerReleaseProcessTree
} from './worker-release-process-tree'
const resource = {
  terminal_handle: 'term',
  process_incarnation: 'pty:inc',
  host_scope: JSON.stringify({ kind: 'local', hostId: 'local' })
} as WorkerTerminalResourceRow
const proof = {
  ptyId: 'pty',
  incarnationId: 'inc',
  rootPid: 100,
  pid: 101,
  pgid: 101,
  startTimeMs: Date.now() - 60000,
  agent: 'codex',
  via: 'command-line' as const
}
const snapshot = () => ({
  root: { pid: 100, startedAt: new Date(Date.now() - 120000).toString() },
  rootPgid: 100,
  descendants: [
    { pid: 101, ppid: 100, pgid: 101, startedAt: new Date(Date.now() - 60000).toString() }
  ],
  capturedAtMs: Date.now()
})
afterEach(() => vi.restoreAllMocks())
describe.skipIf(process.platform === 'win32')('worker release descendant checkpoint', () => {
  it('persists exact identities and rejects a foreign host or process on recovery', async () => {
    vi.spyOn(capture, 'captureDescendantSnapshot').mockResolvedValue(snapshot())
    const runtime = {
      readTerminalProcessEvidence: vi.fn(async () => ({ proof })),
      getTerminalProcessIncarnation: () => 'pty:inc'
    } as unknown as OrcaRuntimeService
    const tree = await captureWorkerReleaseProcessTree(runtime, resource)
    const content = JSON.stringify({ releaseProcessTree: tree })
    expect(readWorkerReleaseProcessTree(content, resource)).toEqual(tree)
    expect(
      readWorkerReleaseProcessTree(content, { ...resource, process_incarnation: 'other' })
    ).toBeNull()
    expect(
      readWorkerReleaseProcessTree(content, {
        ...resource,
        host_scope: '{"kind":"ssh","targetId":"other"}'
      })
    ).toBeNull()
  })
  it('refuses absent, replaced, and capture-second process evidence', async () => {
    vi.spyOn(capture, 'captureDescendantSnapshot').mockResolvedValue(snapshot())
    const read = vi.fn().mockResolvedValue({ proof: null })
    const runtime = {
      readTerminalProcessEvidence: read,
      getTerminalProcessIncarnation: () => 'pty:inc'
    } as unknown as OrcaRuntimeService
    await expect(captureWorkerReleaseProcessTree(runtime, resource)).rejects.toThrow(
      'identity is unavailable'
    )
    read.mockResolvedValueOnce({ proof }).mockResolvedValueOnce({ proof: { ...proof, pid: 102 } })
    await expect(captureWorkerReleaseProcessTree(runtime, resource)).rejects.toThrow(
      'identity changed'
    )
    read.mockResolvedValue({ proof })
    const young = snapshot()
    young.descendants[0].startedAt = new Date().toString()
    vi.mocked(capture.captureDescendantSnapshot).mockResolvedValue(young)
    await expect(captureWorkerReleaseProcessTree(runtime, resource)).rejects.toThrow(
      'identity changed'
    )
  })
})
