import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { createStore, makeTerminalTab, testState } from './persistence-test-harness'
import { TEST_LEAF_1 } from './persistence-session-fixtures'
import { StateSerializationSecretHandlingOperations } from './persistence/loading-store/state-serialization-secret-handling'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const paneKey = `tab1:${TEST_LEAF_1}`
const session = () => ({
  ...getDefaultWorkspaceSession(),
  tabsByWorktree: { wt1: [makeTerminalTab({ id: 'tab1', worktreeId: 'wt1', ptyId: 'pty-1' })] },
  terminalLayoutsByTabId: {
    tab1: {
      root: { type: 'leaf' as const, leafId: TEST_LEAF_1 },
      activeLeafId: TEST_LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1' }
    }
  },
  terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-1' }
})
const bind = (incarnationId = 'inc-1', ptyId = 'pty-1') => ({
  worktreeId: 'wt1',
  tabId: 'tab1',
  leafId: TEST_LEAF_1,
  ptyId,
  incarnationId
})

describe('persistPtyBinding whole-state flush', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'omni-test-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('skips the flush for a rebind already on disk, and flushes every real change', async () => {
    const store = await createStore()
    store.setWorkspaceSession(session())
    const serialize = vi.spyOn(
      StateSerializationSecretHandlingOperations.prototype,
      'buildStateToSave'
    )

    // The renderer's write is still pending, so even an identical binding must be made durable.
    expect(store.persistPtyBinding(bind())).toBe(true)
    expect(serialize).toHaveBeenCalledTimes(1)

    expect(store.persistPtyBinding(bind())).toBe(true)
    expect(serialize).toHaveBeenCalledTimes(1)

    expect(store.persistPtyBinding(bind('inc-2'))).toBe(true)
    expect(serialize).toHaveBeenCalledTimes(2)
    expect(store.persistPtyBinding(bind('inc-2', 'pty-2'))).toBe(true)
    expect(serialize).toHaveBeenCalledTimes(3)

    const reloaded = await createStore()
    const durable = reloaded.getWorkspaceSession()
    expect(durable.terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe('inc-2')
    expect(durable.terminalLayoutsByTabId.tab1?.ptyIdsByLeafId?.[TEST_LEAF_1]).toBe('pty-2')
  })

  it('flushes an unchanged rebind while any other write is still pending', async () => {
    const store = await createStore()
    store.setWorkspaceSession(session())
    store.persistPtyBinding(bind())
    const serialize = vi.spyOn(
      StateSerializationSecretHandlingOperations.prototype,
      'buildStateToSave'
    )

    store.updateSettings({ terminalFontSize: 17 })
    store.persistPtyBinding(bind())
    expect(serialize).toHaveBeenCalledTimes(1)
    expect((await createStore()).getSettings().terminalFontSize).toBe(17)
  })
})
