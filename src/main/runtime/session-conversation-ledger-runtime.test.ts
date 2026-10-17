import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: () => ({ isDestroyed: () => false }), getAllWindows: () => [] },
  ipcMain: { on: vi.fn(), once: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
  app: { getPath: () => '/tmp', isPackaged: false, getVersion: () => '0.0.0' }
}))

import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import {
  SESSION_CONVERSATION_LEDGER_PUBLISHER_NOT_CURRENT_CODE,
  type RuntimeSessionConversationRecord
} from '../../shared/session-conversation-ledger'
import { OrcaRuntimeService } from './omni-runtime'
import { ownerConversationLedgerPath } from './session-conversation-ledger-runtime'
import type {
  SessionConversationLedgerMainSet,
  SessionConversationLedgerStore
} from './session-conversation-ledger-store'

const WT = 'repo::/work'
const RECORD: RuntimeSessionConversationRecord = {
  conversation: null,
  paneIdentity: 'pane:tab-1:leaf-1',
  agent: 'claude',
  providerSession: null,
  title: 'Claude',
  titleSource: 'terminal',
  surface: 'tab',
  paneKey: 'tab-1:leaf-1',
  tabId: 'tab-1',
  rest: 'live',
  listed: true,
  updatedAt: 1
}
const WINDOW_BODY: SessionConversationLedgerMainSet = {
  listedAt: 1,
  coverage: [{ worktreeId: WT, complete: true }],
  omitted: { unknownHost: 0, unverified: 0 },
  folders: [{ id: 'f1', name: 'Church' }],
  projects: [],
  recordsByWorktree: { [WT]: [RECORD] }
}
const MAIN: SessionConversationLedgerMainSet = {
  ...WINDOW_BODY,
  listedAt: 7,
  recordsByWorktree: { [WT]: [{ ...RECORD, rest: 'dormant' }] }
}

const publication = (rendererGeneration: string) => ({ rendererGeneration, ...WINDOW_BODY })

// Why a profile per test: the store keeps its window publication under <userData>/session-host.
let userData = ''
const stores: SessionConversationLedgerStore[] = []

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'conversation-ledger-runtime-'))
  installFakeAppEnvironment({ getPath: () => userData })
})

afterEach(async () => {
  // Why first: a write still pending would recreate the profile directory after its removal.
  await Promise.all(stores.splice(0).map((store) => store.flushOwnerLedger()))
  rmSync(userData, { recursive: true, force: true })
})

function ledgerOf(runtime: OrcaRuntimeService): SessionConversationLedgerStore {
  const store = runtime.getSessionConversationLedgerStore()
  stores.push(store)
  return store
}

/** A desktop window that synced its graph as `r1` and published its conversation ledger. */
function publishedRuntime() {
  const runtime = new OrcaRuntimeService()
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], rendererGeneration: 'r1' })
  const store = ledgerOf(runtime)
  runtime.syncSessionConversationLedger(1, publication('r1'))
  expect(store.snapshot()).toMatchObject({
    source: 'window',
    coverage: [{ worktreeId: WT, complete: true }]
  })
  return { runtime, store, revision: store.snapshot().revision }
}

describe('the owner’s conversation ledger across window lifecycles (session parity, step 2)', () => {
  it('refuses a renderer generation whose graph it does not hold, another window, or junk', () => {
    const { runtime, store, revision } = publishedRuntime()
    expect(() => runtime.syncSessionConversationLedger(1, publication('r0'))).toThrow(
      SESSION_CONVERSATION_LEDGER_PUBLISHER_NOT_CURRENT_CODE
    )
    expect(() => runtime.syncSessionConversationLedger(2, publication('r1'))).toThrow(
      SESSION_CONVERSATION_LEDGER_PUBLISHER_NOT_CURRENT_CODE
    )
    expect(() => runtime.syncSessionConversationLedger(1, { listedAt: 1 })).toThrow(
      'Invalid conversation ledger publication'
    )
    expect(store.snapshot()).toMatchObject({
      revision,
      source: 'window',
      recordsByWorktree: { [WT]: [RECORD] }
    })
  })

  it('falls back to the last records, every workspace incomplete, when the window closes', () => {
    const { runtime, store, revision } = publishedRuntime()
    runtime.markGraphUnavailable(1)
    expect(store.snapshot()).toMatchObject({
      source: 'main',
      revision: revision + 1,
      coverage: [{ worktreeId: WT, complete: false }],
      recordsByWorktree: { [WT]: [RECORD] }
    })
    expect(store.isWindowCurrent()).toBe(false)
  })

  it('falls back to the main set when a failed desktop promotion hands authority back to headless', () => {
    const runtime = new OrcaRuntimeService()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.attachWindow(1)
    // Why seed the store: a window can only publish once its graph is ready, which ends the
    // headless fallback; this isolates restoreHeadlessGraphAuthority's own reset.
    const store = ledgerOf(runtime)
    store.publishWindow(publication('r1'))
    expect(store.publishMain(MAIN)).toBe(false)
    const revision = store.snapshot().revision

    runtime.markGraphReloadFailed(1, 'renderer-process-gone')

    expect(runtime.getStatus()).toMatchObject({ authoritativeWindowId: HEADLESS_RUNTIME_WINDOW_ID })
    expect(store.snapshot()).toMatchObject({
      source: 'main',
      revision: revision + 1,
      listedAt: 7,
      recordsByWorktree: MAIN.recordsByWorktree
    })
  })

  it('falls back when a reload fails and no headless graph takes over', () => {
    const { runtime, store } = publishedRuntime()
    runtime.markGraphReloadFailed(1, 'renderer-process-gone')
    expect(store.snapshot()).toMatchObject({
      source: 'main',
      coverage: [{ worktreeId: WT, complete: false }]
    })
    expect(store.getRendererGeneration()).toBeNull()
  })

  it('keeps the accepted publication in <userData>/session-host/owner-ledger.json', async () => {
    const { store } = publishedRuntime()
    await store.flushOwnerLedger()
    const file = join(userData, 'session-host', 'owner-ledger.json')
    expect(ownerConversationLedgerPath()).toBe(file)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, publication: publication('r1') })
  })
})
