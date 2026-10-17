/**
 * C3 / plan step 5: a runtime-owned process an earlier click started is shown as "running in the
 * background, not in a window" — listed, kept by tidy, adoptable and endable on request — and is
 * never killed automatically.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LEAF,
  TAB,
  WINDOW_ID,
  WT,
  createCallerActivationFixture,
  publishWindowTabs
} from '../runtime/caller-session-tab-activation-fixture'
import { setRuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'
import {
  backgroundTidyRows,
  classifyBackgroundTidy,
  listBackgroundSessionManageEntries,
  type BackgroundRuntimeTerminal
} from './session-manage-background-terminals'
import { showSession } from './session-manage-show'
import { observeSources, sidebarRow } from './session-manage-test-fixtures'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

afterEach(() => {
  setRuntimeDesktopSurface(null)
})

const ORPHAN_LEAF = '33333333-3333-4333-8333-333333333333'
const ORPHAN_PANE = `tab-orphan:${ORPHAN_LEAF}`

function orphanRuntime() {
  const fixture = createCallerActivationFixture()
  const kill = vi.fn(() => true)
  fixture.runtime.setPtyController({
    spawn: fixture.spawn,
    write: () => true,
    kill,
    getForegroundProcess: async () => null
  })
  const ptys = (fixture.runtime as unknown as { ptysById: Map<string, Record<string, unknown>> })
    .ptysById
  const own = (ptyId: string, tabId: string, leafId: string): void => {
    fixture.runtime.registerPty(ptyId, WT, null, { tabId, leafId })
    ptys.get(ptyId)!.runtimeSessionOwned = true
  }
  // A process the window's own tab shows, one a stale click started, and an unowned one.
  own(`${WT}@@window-shown`, TAB, LEAF)
  own(`${WT}@@orphan`, 'tab-orphan', ORPHAN_LEAF)
  fixture.runtime.registerPty(`${WT}@@plain`, WT)
  publishWindowTabs(fixture.runtime, [{ tabId: TAB, leafId: LEAF, ptyId: `${WT}@@window-shown` }])
  return { ...fixture, kill }
}

const orphan: BackgroundRuntimeTerminal = {
  ptyId: `${WT}@@orphan`,
  worktreeId: WT,
  tabId: 'tab-orphan',
  paneKey: ORPHAN_PANE,
  handle: 'term_orphan',
  title: 'claude conversation',
  launchAgent: 'claude',
  hostId: 'local'
}

describe('runtime-owned terminals no window shows', () => {
  it('lists an orphan runtime-owned PTY as background-not-in-window and never kills it', () => {
    const { runtime, kill } = orphanRuntime()

    const listed = runtime.listBackgroundRuntimeOwnedTerminals()

    expect(listed).toEqual([
      expect.objectContaining({
        ptyId: `${WT}@@orphan`,
        worktreeId: WT,
        tabId: 'tab-orphan',
        paneKey: ORPHAN_PANE,
        handle: expect.any(String),
        hostId: 'local'
      })
    ])
    expect(kill).not.toHaveBeenCalled()
  })

  it('cannot tell while the window reloads, so it lists nothing rather than guessing', () => {
    const { runtime } = orphanRuntime()
    runtime.markRendererReloading(WINDOW_ID)

    expect(runtime.listBackgroundRuntimeOwnedTerminals()).toBeNull()
  })

  it('shows the orphan in session list with its placement', async () => {
    const entries = await listBackgroundSessionManageEntries(
      [orphan],
      [sidebarRow({ paneKey: 'tab-1:leaf-1' })],
      observeSources({
        resolvePane: () => ({ handle: 'term_orphan', connected: true, ptyId: 'p' })
      }),
      {}
    )

    expect(entries).toEqual([
      expect.objectContaining({
        paneKey: ORPHAN_PANE,
        terminal: 'term_orphan',
        verdict: 'live',
        placement: 'background-not-in-window'
      })
    ])
  })

  it('does not list a pane the sidebar already shows, nor under a folder filter', async () => {
    const sources = observeSources()
    expect(
      await listBackgroundSessionManageEntries(
        [orphan],
        [sidebarRow({ paneKey: ORPHAN_PANE })],
        sources,
        {}
      )
    ).toEqual([])
    expect(
      await listBackgroundSessionManageEntries([orphan], [], sources, { folderId: 'folder-1' })
    ).toEqual([])
  })

  it('is kept by tidy with that reason, in either mode', async () => {
    const rows = await backgroundTidyRows([orphan], [], observeSources(), undefined)

    expect(rows).toEqual([
      expect.objectContaining({
        paneKey: ORPHAN_PANE,
        action: 'skip',
        group: 'background-not-in-window',
        reason: expect.stringContaining('omni terminal close --terminal term_orphan')
      })
    ])
    expect(await backgroundTidyRows([orphan], [], observeSources(), 'ssh:box')).toEqual([])
  })

  it('is ended by tidy only when the person names it with --delete, never the cleanup itself', () => {
    const named = new Set([ORPHAN_PANE])
    expect(classifyBackgroundTidy(orphan, { include: new Set(), delete: true })).toMatchObject({
      action: 'skip',
      group: 'background-not-in-window'
    })
    expect(classifyBackgroundTidy(orphan, { include: named, delete: false })).toEqual({
      action: 'skip',
      group: 'background-not-in-window',
      reason: 'A background process has no tab to archive; name it with --delete to end it.'
    })
    expect(classifyBackgroundTidy(orphan, { include: named, delete: true })).toMatchObject({
      action: 'delete',
      included: true
    })
    expect(
      classifyBackgroundTidy(orphan, { include: named, delete: true, selfPaneKey: ORPHAN_PANE })
    ).toMatchObject({ action: 'skip', reason: 'This is the session running the cleanup.' })
  })

  it('is never ended while a decision or Question waits on it, even when named', () => {
    const reason = 'Kept: waiting on your answer to a Question.'
    const answerWait = vi.fn(() => reason)
    expect(
      classifyBackgroundTidy(orphan, { include: new Set([ORPHAN_PANE]), delete: true, answerWait })
    ).toEqual({ action: 'skip', reason, group: 'awaiting-answer' })
    expect(answerWait).toHaveBeenCalledWith(orphan)
  })

  it('is adopted visibly by session show', async () => {
    const adoptBackground = vi.fn(async () => ({ tabId: 'tab-orphan', navigated: true }))
    const relay = vi.fn()

    const shown = await showSession(
      {
        readRows: async () => [],
        relay,
        findBackground: (target) => (target.paneKey === ORPHAN_PANE ? orphan : null),
        adoptBackground
      },
      { target: { paneKey: ORPHAN_PANE }, mode: 'beside', flash: true, drivesHostWindow: true }
    )

    expect(adoptBackground).toHaveBeenCalledWith('term_orphan')
    expect(relay).not.toHaveBeenCalled()
    expect(shown).toMatchObject({
      shown: true,
      target: { paneKey: ORPHAN_PANE, tabId: 'tab-orphan', worktreeId: WT },
      summary: expect.stringContaining('was running in the background, not in a window')
    })
  })
})
