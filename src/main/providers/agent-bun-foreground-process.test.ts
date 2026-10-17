import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProcessTableSnapshot from '../../shared/process-table-snapshot'
import { resolveAgentForegroundProcess } from './agent-foreground-process'

const { readRows } = vi.hoisted(() => ({ readRows: vi.fn() }))
vi.mock('../../shared/process-table-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessTableSnapshot>()),
  getProcessTableSnapshot: readRows,
  getFreshProcessTableSnapshot: readRows
}))

const originalPlatform = process.platform
describe('Bun-hosted OMP foreground ownership', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    readRows.mockReset()
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('confirms OMP from the owning PTY process tree', async () => {
    readRows.mockResolvedValue([
      {
        pid: 101,
        ppid: 100,
        stat: 'S+',
        command: 'bun /Users/maintainer/.nvm/versions/node/v22/bin/omp --resume native-session'
      }
    ])
    await expect(resolveAgentForegroundProcess(100, 'bun.exe')).resolves.toBe('omp')
  })

  it('does not borrow identity from another PTY or a stopped Bun child', async () => {
    readRows.mockResolvedValue([
      { pid: 100, ppid: 99, stat: 'S+', command: 'zsh' },
      {
        pid: 101,
        ppid: 100,
        stat: 'T',
        command: 'bun /usr/local/bin/omp --resume stopped-session'
      },
      { pid: 202, ppid: 200, stat: 'S+', command: 'bun /usr/local/bin/omp --resume other-session' }
    ])
    await expect(resolveAgentForegroundProcess(100, 'zsh')).resolves.toBe('zsh')
  })
})
