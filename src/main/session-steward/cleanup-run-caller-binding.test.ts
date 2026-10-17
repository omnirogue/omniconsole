import { describe, expect, it, vi } from 'vitest'
import {
  bindCallerToCleanupRun,
  descendsFrom,
  type CleanupCallerBindingDeps,
  type LiveAutomaticCleanupRun,
  type ProcessParentRow
} from './cleanup-run-caller-binding'

// launchd(1) → app(100) → cleanup PTY shell(200) → claude(210) → bash(220) → omni CLI(230)
//                       → another session's shell(300) → omni CLI(330)
const TABLE: ProcessParentRow[] = [
  { pid: 100, ppid: 1 },
  { pid: 200, ppid: 100 },
  { pid: 210, ppid: 200 },
  { pid: 220, ppid: 210 },
  { pid: 230, ppid: 220 },
  { pid: 300, ppid: 100 },
  { pid: 330, ppid: 300 }
]

const CONTEXT = { source: 'cleanup-run' as const, runId: 'run-1', since: 1 }

function run(overrides: Partial<LiveAutomaticCleanupRun> = {}): LiveAutomaticCleanupRun {
  return {
    context: CONTEXT,
    ptyId: 'pty-cleanup',
    paneKey: 'tab-c:leaf-1',
    workspaceId: 'cleanup-repo::/cleanup',
    manualPaneKeys: new Set(),
    ...overrides
  }
}

const OPEN_PTYS = new Map([['pty-cleanup', 200]])

function deps(overrides: Partial<CleanupCallerBindingDeps> = {}): CleanupCallerBindingDeps {
  return {
    liveAutomaticRun: () => run(),
    lingeringAutomaticRuns: () => [],
    ptyRootPids: async (ptyIds) =>
      new Map([...OPEN_PTYS].filter(([ptyId]) => ptyIds.includes(ptyId))),
    readProcessRows: async () => TABLE,
    verifyPane: () => null,
    ...overrides
  }
}

describe('descendsFrom', () => {
  it('follows parents to the root and stops at init', () => {
    expect(descendsFrom(TABLE, 230, 200)).toBe(true)
    expect(descendsFrom(TABLE, 200, 200)).toBe(true)
    expect(descendsFrom(TABLE, 330, 200)).toBe(false)
    expect(descendsFrom([{ pid: 5, ppid: 5 }], 5, 200)).toBe(false)
  })
})

describe('binding a CLI call to an automatic cleanup run by its process tree', () => {
  it('makes a call from inside the run’s PTY unattended even with its pane evidence stripped', async () => {
    await expect(bindCallerToCleanupRun(deps(), 230)).resolves.toEqual(CONTEXT)
  })

  it('leaves a call from outside the run’s tree to its own evidence', async () => {
    await expect(bindCallerToCleanupRun(deps(), 330)).resolves.toBeNull()
  })

  it('refuses to trust an unproven caller whose ancestry cannot be read', async () => {
    await expect(bindCallerToCleanupRun(deps(), undefined)).resolves.toEqual(CONTEXT)
    await expect(bindCallerToCleanupRun(deps(), 999)).resolves.toEqual(CONTEXT)
    await expect(
      bindCallerToCleanupRun(
        deps({ readProcessRows: () => Promise.reject(new Error('ps failed')) }),
        330
      )
    ).resolves.toEqual(CONTEXT)
  })

  it('trusts a proven pane of another session when ancestry is unknown', async () => {
    const verified = deps({
      verifyPane: () => ({ paneKey: 'tab-9:leaf-1', worktreeId: 'repo::/work' })
    })
    await expect(bindCallerToCleanupRun(verified, undefined)).resolves.toBeNull()
  })

  it('before the run reports its pane, treats a proven pane in the cleanup workspace as the run', async () => {
    const racing = run({ ptyId: null, paneKey: null, manualPaneKeys: new Set(['tab-m:leaf-1']) })
    const inWorkspace = (paneKey: string) =>
      deps({
        liveAutomaticRun: () => racing,
        verifyPane: () => ({ paneKey, worktreeId: 'cleanup-repo::/cleanup' })
      })
    await expect(bindCallerToCleanupRun(inWorkspace('tab-new:leaf-1'), 230)).resolves.toEqual(
      CONTEXT
    )
    await expect(bindCallerToCleanupRun(inWorkspace('tab-m:leaf-1'), 230)).resolves.toBeNull()
  })

  it('does nothing while no automatic run holds the slot or lingers', async () => {
    const readProcessRows = vi.fn(async () => TABLE)
    await expect(
      bindCallerToCleanupRun(deps({ liveAutomaticRun: () => null, readProcessRows }), 230)
    ).resolves.toBeNull()
    expect(readProcessRows).not.toHaveBeenCalled()
  })

  it('still binds a process left behind by a finished run while its terminal is open', async () => {
    const finished = { context: { ...CONTEXT, runId: 'run-0' }, ptyId: 'pty-cleanup' }
    const lingering = deps({
      liveAutomaticRun: () => null,
      lingeringAutomaticRuns: () => [finished]
    })
    // `omni terminal send` carries no pane evidence; only the process tree tells it apart.
    await expect(bindCallerToCleanupRun(lingering, 230)).resolves.toEqual(finished.context)
    await expect(bindCallerToCleanupRun(lingering, 330)).resolves.toBeNull()
    // With no live run, an unreadable caller is not failed closed.
    await expect(bindCallerToCleanupRun(lingering, undefined)).resolves.toBeNull()
  })

  it('reads no process table once a finished run’s terminal is closed', async () => {
    const readProcessRows = vi.fn(async () => TABLE)
    const closed = deps({
      liveAutomaticRun: () => null,
      lingeringAutomaticRuns: () => [{ context: CONTEXT, ptyId: 'pty-gone' }],
      readProcessRows
    })
    await expect(bindCallerToCleanupRun(closed, 230)).resolves.toBeNull()
    expect(readProcessRows).not.toHaveBeenCalled()
  })
})
