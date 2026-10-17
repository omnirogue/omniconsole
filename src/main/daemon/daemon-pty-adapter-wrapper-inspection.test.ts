import { rmSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import type * as AgentForegroundProcess from '../providers/agent-foreground-process'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

const { resolveForeground } = vi.hoisted(() => ({ resolveForeground: vi.fn() }))
vi.mock('../providers/agent-foreground-process', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentForegroundProcess>()),
  resolveAgentForegroundProcessWithAvailability: resolveForeground
}))

it('uses current recognition for a live daemon worker still reporting Bun', async () => {
  resolveForeground.mockResolvedValue({ available: true, processName: 'omp' })
  const subprocess = { ...createMockSubprocess(), getForegroundProcess: () => 'bun.exe' }
  const { adapter, server, dir } = await startDaemonAdapterHarness(() => subprocess)
  try {
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    await expect(adapter.inspectProcess(id)).resolves.toEqual({
      foregroundProcess: 'omp',
      hasChildProcesses: true
    })
    await expect(adapter.getForegroundProcess(id)).resolves.toBe('omp')
    await expect(adapter.confirmForegroundProcess(id)).resolves.toBe('omp')
    expect(resolveForeground).toHaveBeenCalledWith(subprocess.pid, 'bun.exe', {
      fresh: true,
      forceProcessScan: true
    })
    expect(subprocess.kill).not.toHaveBeenCalled()
  } finally {
    adapter.dispose()
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})
