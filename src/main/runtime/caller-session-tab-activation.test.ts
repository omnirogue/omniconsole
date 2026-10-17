/**
 * C3 / plan step 4: a non-host ("caller") activation — a paired computer's click or a phone's tap —
 * may start a process only with positive ownership. Assertions check PTY identity, spawn calls
 * and what the owner's window was asked to show, not only that nothing crashed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'
import {
  LEAF,
  STALE_PTY,
  SURFACE,
  TAB,
  WINDOW_ID,
  WT,
  callerActivate,
  closeWindowAfterPublishing,
  createCallerActivationFixture,
  injectStaleSurface,
  publishWindowTabs
} from './caller-session-tab-activation-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

afterEach(() => {
  setRuntimeDesktopSurface(null)
})

const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'

describe('caller activation: confirmed absence', () => {
  it('answers tab_not_found for a row the window no longer publishes, and creates nothing', async () => {
    const fixture = createCallerActivationFixture()
    publishWindowTabs(fixture.runtime, [{ tabId: 'tab-2', leafId: OTHER_LEAF }])

    await expect(callerActivate(fixture.runtime)).rejects.toThrow('tab_not_found')
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.mountRequests).toEqual([])
  })

  it('refuses a stale pending row only an old snapshot keeps, without resuming its PTY id', async () => {
    const fixture = createCallerActivationFixture()
    publishWindowTabs(fixture.runtime, [{ tabId: 'tab-2', leafId: OTHER_LEAF }])
    injectStaleSurface(fixture, { tabId: TAB, leafId: LEAF, ptyId: STALE_PTY })

    await expect(callerActivate(fixture.runtime, TAB, LEAF, 'user')).rejects.toThrow(
      'tab_not_found'
    )
    // Why: before the fix this spawned with sessionId = the stale PTY id (daemon reattach).
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses a stale ready surface only an old snapshot keeps listed', async () => {
    const fixture = createCallerActivationFixture()
    publishWindowTabs(fixture.runtime, [{ tabId: 'tab-2', leafId: OTHER_LEAF }])
    const unrelated = `${WT}@@unrelated-live`
    fixture.runtime.registerPty(unrelated, WT)
    injectStaleSurface(fixture, { tabId: TAB, leafId: LEAF, ptyId: unrelated })
    expect(
      (await fixture.runtime.listMobileSessionTabs(`id:${WT}`)).tabs.find(
        (tab) => tab.id === SURFACE
      )
    ).toMatchObject({ status: 'ready' })

    await expect(callerActivate(fixture.runtime)).rejects.toThrow('tab_not_found')
  })

  it('still attaches a ready surface the window lists', async () => {
    const fixture = createCallerActivationFixture()
    const live = `${WT}@@listed-live`
    fixture.runtime.registerPty(live, WT)
    publishWindowTabs(fixture.runtime, [{ tabId: TAB, leafId: LEAF, ptyId: live }])

    const activated = await callerActivate(fixture.runtime)

    expect(activated.tabs.find((tab) => tab.id === SURFACE)).toMatchObject({ status: 'ready' })
    expect(fixture.spawn).not.toHaveBeenCalled()
  })
})

describe('caller activation: unavailable or incomplete publication', () => {
  it('refuses retryably while no window has published yet this run (starting up)', async () => {
    const fixture = createCallerActivationFixture()

    await expect(callerActivate(fixture.runtime, TAB, LEAF, 'user')).rejects.toMatchObject({
      code: 'session_tab_unverifiable',
      data: { retryable: true, reason: 'no-publisher' },
      message: expect.stringContaining('still loading its sessions')
    })
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses retryably while the window reloads, and keeps the row', async () => {
    const fixture = createCallerActivationFixture()
    publishWindowTabs(fixture.runtime, [{ tabId: TAB, leafId: LEAF }])
    fixture.runtime.markRendererReloading(WINDOW_ID)

    await expect(callerActivate(fixture.runtime, TAB, LEAF, 'user')).rejects.toMatchObject({
      code: 'session_tab_unverifiable',
      data: { reason: 'graph-not-ready' }
    })
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.mountRequests).toEqual([])
    expect(fixture.internals.mobileSessionTabsByWorktree.get(WT)?.tabs).toEqual([
      expect.objectContaining({ id: SURFACE })
    ])
  })

  it('treats a workspace absent from the window’s complete inventory as closed', async () => {
    const fixture = createCallerActivationFixture()
    fixture.runtime.attachWindow(WINDOW_ID)
    fixture.runtime.syncWindowGraph(WINDOW_ID, { tabs: [], leaves: [], mobileSessionTabs: [] })

    await expect(callerActivate(fixture.runtime)).rejects.toThrow('tab_not_found')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses retryably while the window’s inventory is still incomplete', async () => {
    const fixture = createCallerActivationFixture()
    fixture.runtime.attachWindow(WINDOW_ID)
    fixture.runtime.syncWindowGraph(WINDOW_ID, { tabs: [], leaves: [] })

    await expect(callerActivate(fixture.runtime)).rejects.toMatchObject({
      code: 'session_tab_unverifiable',
      data: { reason: 'inventory-not-authoritative' }
    })
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses retryably when a window reload lands during launch resolution', async () => {
    // A serve-bound surface the window does not list: the only kind created here beside a window.
    const fixture = createCallerActivationFixture({ persistedPtyId: 'serve-dead' })
    publishWindowTabs(fixture.runtime, [{ tabId: 'tab-2', leafId: OTHER_LEAF }])
    injectStaleSurface(fixture, { tabId: TAB, leafId: LEAF, ptyId: 'serve-dead' })
    const internals = fixture.runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: () => Promise<unknown>
    }
    vi.mocked(internals.resolveTerminalWorkspaceLaunchScope).mockImplementation(async () => {
      fixture.runtime.markRendererReloading(WINDOW_ID)
      return { id: WT, path: '/repo/app', connectionId: null, repo: null, folderWorkspace: null }
    })

    await expect(callerActivate(fixture.runtime, TAB, LEAF, 'user')).rejects.toMatchObject({
      code: 'session_tab_unverifiable'
    })
    expect(fixture.spawn).not.toHaveBeenCalled()
  })
})

describe('caller activation: a window closed while the app runs', () => {
  it('starts a saved surface from the persisted session, for the window to adopt on reopen', async () => {
    const fixture = createCallerActivationFixture()
    closeWindowAfterPublishing(fixture.runtime)

    const activated = await callerActivate(fixture.runtime, TAB, LEAF, 'user')

    expect(fixture.spawn).toHaveBeenCalledOnce()
    expect(fixture.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: TAB, leafId: LEAF, sessionId: STALE_PTY })
    )
    expect(activated.tabs.find((tab) => tab.id === SURFACE)).toMatchObject({ status: 'ready' })
  })

  it('treats a row the persisted session no longer lists as closed', async () => {
    const fixture = createCallerActivationFixture()
    closeWindowAfterPublishing(fixture.runtime)
    await fixture.runtime.listMobileSessionTabs(`id:${WT}`)
    fixture.dropPersistedTab()

    await expect(callerActivate(fixture.runtime, TAB, LEAF, 'user')).rejects.toThrow(
      'tab_not_found'
    )
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('never recreates a closed split leaf whose parent tab is still saved', async () => {
    const fixture = createCallerActivationFixture()
    fixture.runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    await fixture.runtime.listMobileSessionTabs(`id:${WT}`)
    injectStaleSurface(fixture, { tabId: TAB, leafId: OTHER_LEAF, ptyId: `${WT}@@closed-leaf` })

    await expect(callerActivate(fixture.runtime, TAB, OTHER_LEAF, 'user')).rejects.toThrow(
      'tab_not_found'
    )
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('rechecks after the agent admission gate and starts nothing for a tab closed meanwhile', async () => {
    const fixture = createCallerActivationFixture({ launchAgent: 'claude' })
    closeWindowAfterPublishing(fixture.runtime)
    await fixture.runtime.listMobileSessionTabs(`id:${WT}`)
    const launched = vi.fn()
    fixture.spawn.mockImplementation(async (opts) => {
      // Why: the tab closes while this start waits in the admission queue.
      fixture.dropPersistedTab()
      const stored = fixture.internals.mobileSessionTabsByWorktree.get(WT)!
      fixture.internals.mobileSessionTabsByWorktree.set(WT, { ...stored, tabs: [] })
      opts.afterAgentLaunchAdmission?.()
      launched()
      return { id: 'never' }
    })

    await expect(callerActivate(fixture.runtime, TAB, LEAF, 'user')).rejects.toThrow(
      'tab_not_found'
    )
    expect(launched).not.toHaveBeenCalled()
  })
})

describe('caller activation: positive ownership', () => {
  it('attaches a live runtime-owned binding and never recreates it', async () => {
    const fixture = createCallerActivationFixture()
    publishWindowTabs(fixture.runtime, [{ tabId: 'tab-2', leafId: OTHER_LEAF }])
    const owned = `${WT}@@runtime-owned`
    fixture.runtime.registerPty(owned, WT, null, { tabId: TAB, leafId: LEAF })
    const ptys = (fixture.runtime as unknown as { ptysById: Map<string, Record<string, unknown>> })
      .ptysById
    ptys.get(owned)!.runtimeSessionOwned = true
    injectStaleSurface(fixture, { tabId: TAB, leafId: LEAF, ptyId: owned })

    const activated = await callerActivate(fixture.runtime, TAB, LEAF, 'user')

    expect(fixture.spawn).not.toHaveBeenCalled()
    const background = fixture.runtime.listBackgroundRuntimeOwnedTerminals()
    expect(background).toEqual([expect.objectContaining({ ptyId: owned })])
    expect(activated.tabs.find((tab) => tab.id === SURFACE)).toMatchObject({
      status: 'ready',
      ptyId: owned,
      terminal: background![0]!.handle
    })
  })

  it('mounts a window-listed, not-running surface through that window with an acknowledgement', async () => {
    const fixture = createCallerActivationFixture()
    publishWindowTabs(fixture.runtime, [{ tabId: TAB, leafId: LEAF }])

    await callerActivate(fixture.runtime, TAB, LEAF, 'automatic')
    await callerActivate(fixture.runtime, TAB, LEAF, 'user')

    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.focusTerminal).not.toHaveBeenCalled()
    expect(fixture.mountRequests).toEqual([
      // Why: an automatic probe mounts held; only a person's open releases a restore hold.
      { worktreeId: WT, tabId: TAB, leafId: LEAF, requestId: expect.any(String) },
      {
        worktreeId: WT,
        tabId: TAB,
        leafId: LEAF,
        requestId: expect.any(String),
        personOpen: true
      }
    ])
  })

  it.each([
    ['serve', 'serve-dead'],
    ['SSH', 'ssh:ssh-1@@relay-pty']
  ])(
    'mounts a window-listed %s-bound surface through the window, never beside it',
    async (_, ptyId) => {
      const fixture = createCallerActivationFixture({ persistedPtyId: ptyId })
      publishWindowTabs(fixture.runtime, [{ tabId: TAB, leafId: LEAF, ptyId }])

      await callerActivate(fixture.runtime, TAB, LEAF, 'user')

      expect(fixture.spawn).not.toHaveBeenCalled()
      expect(fixture.mountRequests).toEqual([
        expect.objectContaining({ worktreeId: WT, tabId: TAB, leafId: LEAF, personOpen: true })
      ])
    }
  )

  it.each(['parked', 'completed'] as const)(
    'does not mount a %s pane the window lists for an automatic probe, only for a person',
    async (hold) => {
      const fixture = createCallerActivationFixture({ hold })
      publishWindowTabs(fixture.runtime, [{ tabId: TAB, leafId: LEAF }])

      const probed = await callerActivate(fixture.runtime, TAB, LEAF, 'automatic')

      expect(fixture.mountRequests).toEqual([])
      expect(probed.tabs.find((tab) => tab.id === SURFACE)).toMatchObject({
        status: 'pending-handle',
        automaticActivationHold: hold
      })
      await callerActivate(fixture.runtime, TAB, LEAF, 'user')
      expect(fixture.mountRequests).toEqual([expect.objectContaining({ personOpen: true })])
      expect(fixture.spawn).not.toHaveBeenCalled()
    }
  )

  it('reports a failed window mount with no invisible fallback', async () => {
    const fixture = createCallerActivationFixture()
    publishWindowTabs(fixture.runtime, [{ tabId: TAB, leafId: LEAF }])

    fixture.setMountOutcome('mount_timeout')
    await expect(callerActivate(fixture.runtime, TAB, LEAF, 'user')).rejects.toMatchObject({
      code: 'session_tab_mount_failed'
    })
    fixture.setMountOutcome('tab_not_found')
    await expect(callerActivate(fixture.runtime, TAB, LEAF, 'user')).rejects.toThrow(
      'tab_not_found'
    )
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('restores a verified headless surface with its persisted identity', async () => {
    const fixture = createCallerActivationFixture()
    fixture.runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    const activated = await callerActivate(fixture.runtime, TAB, LEAF, 'user')

    expect(fixture.spawn).toHaveBeenCalledOnce()
    expect(fixture.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: TAB, leafId: LEAF, sessionId: STALE_PTY })
    )
    expect(activated.tabs.find((tab) => tab.id === SURFACE)).toMatchObject({ status: 'ready' })
  })

  it('refuses a headless row its persisted session no longer lists', async () => {
    const fixture = createCallerActivationFixture()
    fixture.runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    await fixture.runtime.listMobileSessionTabs(`id:${WT}`)
    fixture.dropPersistedTab()

    await expect(callerActivate(fixture.runtime, TAB, LEAF, 'user')).rejects.toThrow(
      'tab_not_found'
    )
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses when the tab closes while its launch is being resolved', async () => {
    const fixture = createCallerActivationFixture({ launchAgent: 'claude' })
    fixture.runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    await fixture.runtime.listMobileSessionTabs(`id:${WT}`)
    vi.spyOn(
      fixture.runtime as unknown as { resolveMobileSessionTerminalCommand: () => Promise<object> },
      'resolveMobileSessionTerminalCommand'
    ).mockImplementation(async () => {
      fixture.dropPersistedTab()
      const stored = fixture.internals.mobileSessionTabsByWorktree.get(WT)!
      fixture.internals.mobileSessionTabsByWorktree.set(WT, { ...stored, tabs: [] })
      return {}
    })

    await expect(callerActivate(fixture.runtime, TAB, LEAF, 'user')).rejects.toThrow(
      'tab_not_found'
    )
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('keeps host-targeted activation unchanged (the local CLI and desktop still materialize)', async () => {
    const fixture = createCallerActivationFixture({ persistedPtyId: null })

    await fixture.runtime.activateMobileSessionTab(`id:${WT}`, TAB, LEAF)

    expect(fixture.spawn).toHaveBeenCalledOnce()
  })
})
