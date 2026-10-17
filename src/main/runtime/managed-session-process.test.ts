import { describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type { PtyLaunchGateReceipt } from '../../shared/pty-launch-gate'
import { readManagedSessionProcess } from './managed-session-process'

const gate = { pid: 401, processStartTimeMs: 100_321 } as PtyLaunchGateReceipt
const root = { pid: 401, ppid: 300, stat: 'S+', command: '/opt/codex' }
function deps(rows: ProcessTableRow[] = [root]) {
  return {
    platform: 'darwin' as const,
    readRows: vi.fn(async () => rows),
    readBirths: vi.fn(async () => new Map<number, number | null>([[401, 100_000]]))
  }
}

describe('managed exact provider process', () => {
  it('proves only the native provider at the original gate PID', async () => {
    const readers = deps()
    expect(await readManagedSessionProcess(gate, 'codex', 401, readers)).toEqual({
      pid: 401,
      startTimeMs: 100_000,
      provider: 'codex',
      rootPid: 401,
      rootStartTimeMs: 100_321,
      live: true
    })
    expect(readers.readRows).toHaveBeenCalledTimes(2)
    expect(readers.readBirths).toHaveBeenCalledTimes(2)
  })

  it('proves a directly execed Claude agent at the original PID', async () => {
    expect(
      await readManagedSessionProcess(
        gate,
        'claude',
        401,
        deps([{ ...root, command: '/usr/local/bin/claude' }])
      )
    ).toMatchObject({ pid: 401, provider: 'claude', live: true })
  })

  it('refuses even a unique native child of a Codex wrapper before first binding', async () => {
    const readers = deps([
      { ...root, command: '/usr/local/bin/node /opt/node_modules/@openai/codex/bin/codex.js' },
      { pid: 402, ppid: 401, stat: 'S+', command: '/opt/codex' }
    ])
    expect(await readManagedSessionProcess(gate, 'codex', 402, readers)).toBeNull()
    expect(readers.readRows).not.toHaveBeenCalled()
  })

  it.each(['shell', 'other-provider', 'stopped', 'zombie', 'background', 'duplicate-pid'] as const)(
    'refuses %s process evidence',
    async (kind) => {
      const row = { ...root }
      if (kind === 'shell') {
        row.command = '/bin/zsh'
      }
      if (kind === 'other-provider') {
        row.command = '/usr/local/bin/claude'
      }
      if (kind === 'stopped') {
        row.stat = 'T+'
      }
      if (kind === 'zombie') {
        row.stat = 'Z+'
      }
      if (kind === 'background') {
        row.stat = 'S'
      }
      expect(
        await readManagedSessionProcess(
          gate,
          'codex',
          401,
          deps(kind === 'duplicate-pid' ? [row, row] : [row])
        )
      ).toBeNull()
    }
  )

  it.each(['missing', 'reused', 'changed-during-read'] as const)(
    'refuses %s birth evidence',
    async (kind) => {
      const readers = deps()
      if (kind === 'missing') {
        readers.readBirths.mockResolvedValueOnce(new Map([[401, null]]))
      }
      if (kind === 'reused') {
        readers.readBirths.mockResolvedValueOnce(new Map([[401, 102_000]]))
      }
      if (kind === 'changed-during-read') {
        readers.readBirths
          .mockResolvedValueOnce(new Map([[401, 100_000]]))
          .mockResolvedValueOnce(new Map([[401, 102_000]]))
      }
      expect(await readManagedSessionProcess(gate, 'codex', 401, readers)).toBeNull()
    }
  )

  it('refuses command replacement between snapshots', async () => {
    const readers = deps()
    readers.readRows
      .mockResolvedValueOnce([root])
      .mockResolvedValueOnce([{ ...root, command: '/usr/local/bin/claude' }])
    expect(await readManagedSessionProcess(gate, 'codex', 401, readers)).toBeNull()
  })

  it('refuses unsupported platforms without launching an inspection', async () => {
    const readers = deps()
    expect(
      await readManagedSessionProcess(gate, 'codex', 401, { ...readers, platform: 'linux' })
    ).toBeNull()
    expect(readers.readRows).not.toHaveBeenCalled()
  })

  it('returns unavailable for reader failure', async () => {
    const readers = deps()
    readers.readRows.mockRejectedValue(new Error('snapshot unavailable'))
    expect(await readManagedSessionProcess(gate, 'codex', 401, readers)).toBeNull()
  })
})
