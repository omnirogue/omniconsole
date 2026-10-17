import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import {
  _resetLaunchTriggerHintsForTests,
  takeLaunchCauseHints
} from '../observability/launch-trigger-hints'

afterEach(() => _resetLaunchTriggerHintsForTests())

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => ({ isDestroyed: () => false })) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const WORKTREE_ID = 'repo-1::/tmp/wt-trigger'

function createRuntime(): { runtime: OrcaRuntimeService; spawn: ReturnType<typeof vi.fn> } {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(
    runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
    },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockResolvedValue({
    id: WORKTREE_ID,
    path: '/tmp/wt-trigger',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  const spawn = vi.fn().mockResolvedValue({ id: `${WORKTREE_ID}@@a1b2c3d4` })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  } as never)
  runtime.attachWindow(1)
  return { runtime, spawn }
}

function lastSpawnArgs(spawn: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return spawn.mock.calls.at(-1)?.[0] as Record<string, unknown>
}

describe('runtime terminal launch trigger', () => {
  it('passes no launch cause for a main-internal create', async () => {
    const { runtime, spawn } = createRuntime()

    // The shape conversation-capacity-recovery uses for its successor agent.
    await runtime.createTerminal(`id:${WORKTREE_ID}`, {
      command: 'codex',
      viewMode: 'chat',
      activate: false,
      surfaceOwner: false
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(lastSpawnArgs(spawn)).toHaveProperty('launchCause', undefined)
  })

  it('passes the cause a terminal RPC caller named to the spawn', async () => {
    const { runtime, spawn } = createRuntime()

    await runtime.createTerminal(`id:${WORKTREE_ID}`, {
      command: 'claude',
      launchCause: { trigger: 'cli' }
    })
    expect((lastSpawnArgs(spawn).launchCause as { trigger: string }).trigger).toBe('cli')

    await runtime.createTerminal(`id:${WORKTREE_ID}`, {
      command: 'claude',
      launchCause: { trigger: 'mobile-wake' }
    })
    expect((lastSpawnArgs(spawn).launchCause as { trigger: string }).trigger).toBe('mobile-wake')
  })

  it("records a phone's session create as a mobile wake, in the admission person lane", async () => {
    // The phone's session create (no desktop window, or a tab tapped on the phone): #927 starts it
    // in the person lane, so #926's launch.trigger names the same phone request.
    const { runtime, spawn } = createRuntime()
    const internals = runtime as unknown as {
      createRuntimeOwnedMobileSessionTerminal: (
        worktreeId: string,
        activate: boolean,
        afterTabId?: string,
        opts?: { command?: string; launchCause?: { trigger: 'mobile-wake' } }
      ) => Promise<unknown>
    }
    // Why catch: only the spawn arguments matter; publishing the session afterwards needs
    // mobile-session state this fixture does not build.
    await internals
      .createRuntimeOwnedMobileSessionTerminal(WORKTREE_ID, false, undefined, {
        command: 'claude',
        launchCause: { trigger: 'mobile-wake' }
      })
      .catch(() => undefined)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(lastSpawnArgs(spawn)).toMatchObject({
      launchCause: { trigger: 'mobile-wake' },
      launchPriority: 'person'
    })
  })

  it('preserves the parent pane and actor in a renderer split cause', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)
    const tabId = '11111111-1111-4111-8111-111111111111'
    const leafId = '22222222-2222-4222-8222-222222222222'
    runtime.syncWindowGraph(1, {
      tabs: [
        { tabId, worktreeId: WORKTREE_ID, title: 'Shell', activeLeafId: leafId, layout: null }
      ],
      leaves: [{ tabId, worktreeId: WORKTREE_ID, leafId, paneRuntimeId: 1, ptyId: 'pty-graph' }]
    })
    const handle = runtime.resolveTerminalPane(`${tabId}:${leafId}`)!.handle
    vi.spyOn(
      runtime as unknown as { waitForLeafInTab: () => Promise<string> },
      'waitForLeafInTab'
    ).mockResolvedValue('term_split')
    const splitTerminal = vi.fn()
    runtime.setNotifier({ splitTerminal } as never)
    await runtime.splitTerminal(handle, { launchCause: { trigger: 'coordinator-shell' } })
    expect(
      takeLaunchCauseHints({
        worktreeId: WORKTREE_ID,
        tabId,
        leafId: splitTerminal.mock.calls[0][2].newLeafId,
        hasLaunchCommand: false
      }).tabCause
    ).toEqual({
      trigger: 'coordinator-shell',
      actor: { kind: 'app' },
      parentPaneKey: `${tabId}:${leafId}`
    })
  })

  it('passes the named cause, or none, to a split of a runtime-owned terminal', async () => {
    const { runtime, spawn } = createRuntime()
    const source = await runtime.createTerminal(`id:${WORKTREE_ID}`, {})
    vi.spyOn(
      runtime as unknown as { resolveTerminalSplitSourceAuthority: () => unknown },
      'resolveTerminalSplitSourceAuthority'
    ).mockReturnValue({
      persisted: false,
      rendererMounted: true,
      persistedWorktreeId: null,
      persistedIncarnationId: null,
      liveIncarnationId: null
    })

    spawn.mockResolvedValueOnce({ id: `${WORKTREE_ID}@@b2c3d4e5` })
    // Why catch: only the spawn arguments matter here; publishing the split afterwards
    // needs workspace-session state this fixture does not build.
    await runtime
      .splitTerminal(source.handle, { command: 'claude', launchCause: { trigger: 'cli' } })
      .catch(() => undefined)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect((lastSpawnArgs(spawn).launchCause as { trigger: string }).trigger).toBe('cli')

    spawn.mockResolvedValueOnce({ id: `${WORKTREE_ID}@@c3d4e5f6` })
    await runtime.splitTerminal(source.handle, { command: 'claude' }).catch(() => undefined)
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(lastSpawnArgs(spawn).launchCause).toMatchObject({ trigger: 'unknown' })
  })
})
