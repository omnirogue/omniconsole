/**
 * Drives the real `Store`, not the helper and not a fake.
 *
 * `preserveRuntimeAuthoredWorkspaceSessionFields` is only worth anything where the shipping writers
 * call it, and a mutation that unwires it at the call site survives every test that drives the
 * helper directly. Both desktop write paths belong here: the ordinary session write and the
 * before-unload stage, which is the one the desktop actually takes when the user quits.
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PersistedClientHostedBrowserPage } from '../../../shared/client-hosted-browser-page-record'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'omni-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { Store } = await import('./store')

const HOST_ID = 'ssh:user@host'
const WT = 'repo-1::/tmp/worktree-a'

const stores: InstanceType<typeof Store>[] = []

afterEach(() => {
  // Leaving a debounced save armed would write into a temp dir after the test file finishes.
  for (const store of stores.splice(0)) {
    store.flush()
  }
  vi.restoreAllMocks()
})

function createStore(): InstanceType<typeof Store> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'omni-store-runtime-authored-')))
  const store = new Store({ dataFile: join(dir, 'omni-data.json') })
  stores.push(store)
  return store
}

function page(): PersistedClientHostedBrowserPage {
  return {
    v: 1,
    browserPageId: 'page-a',
    workspaceId: WT,
    browserProfileId: 'default',
    url: 'https://example.test/a',
    title: 'A',
    pairedDeviceId: 'device-1',
    savedAt: 1
  }
}

/** What the renderer builds from Zustand: it has never heard of the runtime-authored field. */
function rendererSession(activeTabId: string): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  } as WorkspaceSessionState
}

function seedRuntimeRows(store: InstanceType<typeof Store>, hostId?: string): void {
  store.setWorkspaceSession(
    {
      ...rendererSession('seed'),
      clientHostedBrowserPagesByWorktree: { [WT]: [page()] }
    },
    hostId
  )
}

describe('Store keeps runtime-authored session fields across desktop writes', () => {
  it('preserves the rows when the renderer writes the local session', () => {
    const store = createStore()
    seedRuntimeRows(store)

    store.setWorkspaceSession(rendererSession('after-write'))

    expect(store.getWorkspaceSession().clientHostedBrowserPagesByWorktree).toEqual({
      [WT]: [page()]
    })
    expect(store.getWorkspaceSession().activeTabId).toBe('after-write')
  })

  it('preserves the rows on the quit path the desktop actually takes', () => {
    const store = createStore()
    seedRuntimeRows(store)

    // The beforeunload chain (use-app-session-persistence -> stageBeforeUnloadSync ->
    // renderer-shutdown-checkpoint) lands here, and it is the last write before the process exits.
    store.stageWorkspaceSessionBeforeUnload(rendererSession('before-unload'))

    expect(store.getWorkspaceSession().clientHostedBrowserPagesByWorktree).toEqual({
      [WT]: [page()]
    })
  })

  it('preserves the rows on a remote host partition, on both write paths', () => {
    const store = createStore()
    seedRuntimeRows(store, HOST_ID)

    store.setWorkspaceSession(rendererSession('after-write'), HOST_ID)
    expect(store.getWorkspaceSession(HOST_ID).clientHostedBrowserPagesByWorktree).toEqual({
      [WT]: [page()]
    })

    store.stageWorkspaceSessionBeforeUnload(rendererSession('before-unload'), HOST_ID)
    expect(store.getWorkspaceSession(HOST_ID).clientHostedBrowserPagesByWorktree).toEqual({
      [WT]: [page()]
    })
  })

  it('still lets the runtime clear its own rows', () => {
    const store = createStore()
    seedRuntimeRows(store)

    // The runtime writes an empty map rather than omitting the field, which is what separates its
    // authoritative clear from a renderer write that simply never mentions it.
    store.setWorkspaceSession({
      ...rendererSession('runtime-clear'),
      clientHostedBrowserPagesByWorktree: {}
    })

    expect(store.getWorkspaceSession().clientHostedBrowserPagesByWorktree).toEqual({})
  })

  it('drops the rows for a removed worktree and keeps its siblings', () => {
    const store = createStore()
    const other = 'repo-1::/tmp/worktree-b'
    store.setWorkspaceSession({
      ...rendererSession('seed'),
      clientHostedBrowserPagesByWorktree: {
        [WT]: [page()],
        [other]: [{ ...page(), browserPageId: 'page-b', workspaceId: other }]
      }
    })

    store.removeWorkspaceSessionStateForWorktree(WT)

    expect(
      Object.keys(store.getWorkspaceSession().clientHostedBrowserPagesByWorktree ?? {})
    ).toEqual([other])
  })

  it('still lets the runtime drop one worktree while keeping another', () => {
    const store = createStore()
    const other = 'repo-1::/tmp/worktree-b'
    store.setWorkspaceSession({
      ...rendererSession('seed'),
      clientHostedBrowserPagesByWorktree: {
        [WT]: [page()],
        [other]: [{ ...page(), browserPageId: 'page-b', workspaceId: other }]
      }
    })

    store.setWorkspaceSession({
      ...rendererSession('runtime-partial-clear'),
      clientHostedBrowserPagesByWorktree: {
        [other]: [{ ...page(), browserPageId: 'page-b', workspaceId: other }]
      }
    })

    expect(
      Object.keys(store.getWorkspaceSession().clientHostedBrowserPagesByWorktree ?? {})
    ).toEqual([other])
  })
})

describe('Store fences owner checkpoint retirement with host terminal topology', () => {
  const leafId = '00000000-0000-4000-8000-000000000001'
  const paneKey = `owner-tab:${leafId}`
  const checkpoint = {
    paneKey,
    tabId: 'owner-tab',
    worktreeId: WT,
    agent: 'codex' as const,
    providerSession: { key: 'session_id' as const, id: 'provider-owner' },
    prompt: '',
    state: 'done' as const,
    capturedAt: 100,
    updatedAt: 100,
    ownerSleepPtyIncarnationId: 'inc-owner'
  }
  function seed(): WorkspaceSessionState {
    return {
      ...rendererSession('owner-tab'),
      tabsByWorktree: {
        [WT]: [
          {
            id: 'owner-tab',
            worktreeId: WT,
            ptyId: null,
            title: 'Owner',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'owner-tab': {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null
        }
      },
      sleepingAgentSessionsByPaneKey: { [paneKey]: checkpoint },
      terminalTopologyRevisionByRepoId: { 'repo-1': 10 }
    }
  }

  it.each([undefined, HOST_ID])(
    'preserves a checkpoint when an old %s writer sends empty topology',
    (hostId) => {
      const store = createStore()
      store.setWorkspaceSession(seed(), hostId)
      store.setWorkspaceSession(
        {
          ...rendererSession('stale'),
          tabsByWorktree: { [WT]: [] },
          sleepingAgentSessionsByPaneKey: {}
        },
        hostId
      )
      const readback = store.getWorkspaceSession(hostId)
      expect(readback.tabsByWorktree[WT].some((tab) => tab.id === 'owner-tab')).toBe(true)
      expect(readback.sleepingAgentSessionsByPaneKey?.[paneKey]).toMatchObject(checkpoint)
    }
  )

  it('drops an owner checkpoint carried by the runtime retirement snapshot itself', () => {
    const store = createStore()
    store.setWorkspaceSession(seed())
    store.setWorkspaceSession({
      ...seed(),
      tabsByWorktree: { [WT]: [] },
      terminalLayoutsByTabId: {},
      terminalTopologyRevisionByRepoId: { 'repo-1': 11 }
    })
    expect(store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[paneKey]).toBeUndefined()
  })

  it.each([undefined, HOST_ID])(
    'retires the checkpoint with a newer %s host close revision',
    (hostId) => {
      const store = createStore()
      store.setWorkspaceSession(seed(), hostId)
      store.setWorkspaceSession(
        {
          ...rendererSession('closed'),
          tabsByWorktree: { [WT]: [] },
          sleepingAgentSessionsByPaneKey: {},
          terminalTopologyRevisionByRepoId: { 'repo-1': 11 }
        },
        hostId
      )
      expect(
        store.getWorkspaceSession(hostId).sleepingAgentSessionsByPaneKey?.[paneKey]
      ).toBeUndefined()
    }
  )
})
