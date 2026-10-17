import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: () => ({ isDestroyed: () => false }), getAllWindows: () => [] },
  ipcMain: { on: vi.fn(), once: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
  app: { getPath: () => '/tmp', isPackaged: false, getVersion: () => '0.0.0' }
}))

import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import type { RuntimeSessionWorkflowRecord } from '../../shared/session-workflow-records'
import { OrcaRuntimeService } from './omni-runtime'

const WT = 'repo::/work'
const RECORD: RuntimeSessionWorkflowRecord = {
  tabId: 'flow-tab',
  preset: 'council',
  title: 'Council',
  status: 'running',
  runId: 'run-1'
}

/** A desktop window that synced its graph as `r1` and published one workflow. */
function publishedRuntime() {
  const runtime = new OrcaRuntimeService()
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [], rendererGeneration: 'r1' })
  runtime.syncSessionWorkflowRecords(1, {
    rendererGeneration: 'r1',
    recordsByWorktree: { [WT]: [RECORD] }
  })
  const store = runtime.getSessionWorkflowRecordStore()
  expect(store.snapshot().complete).toBe(true)
  return { runtime, store, revision: store.snapshot().revision }
}

describe('the owner’s workflow set across window lifecycles (step 9)', () => {
  it('refuses a renderer generation whose graph it does not hold', () => {
    const { runtime, store, revision } = publishedRuntime()
    expect(() =>
      runtime.syncSessionWorkflowRecords(1, { rendererGeneration: 'r0', recordsByWorktree: {} })
    ).toThrow('session_workflow_records_publisher_not_current')
    expect(store.snapshot()).toMatchObject({ revision, recordsByWorktree: { [WT]: [RECORD] } })
  })

  it('goes incomplete, keeping its records, when the window closes with no headless fallback', () => {
    const { runtime, store, revision } = publishedRuntime()
    runtime.markGraphUnavailable(1)
    expect(store.snapshot()).toMatchObject({
      complete: false,
      revision: revision + 1,
      recordsByWorktree: { [WT]: [RECORD] }
    })
  })

  it('goes incomplete when a failed desktop promotion hands authority back to headless', () => {
    const runtime = new OrcaRuntimeService()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.attachWindow(1)
    // Why seed the store: a window can only publish once its graph is ready, which ends the
    // headless fallback; this isolates restoreHeadlessGraphAuthority's own reset.
    const store = runtime.getSessionWorkflowRecordStore()
    store.publish({
      rendererGeneration: 'r1',
      recordsByWorktree: { [WT]: [RECORD] },
      complete: true
    })
    const revision = store.snapshot().revision

    runtime.markGraphReloadFailed(1, 'renderer-process-gone')

    expect(runtime.getStatus()).toMatchObject({ authoritativeWindowId: HEADLESS_RUNTIME_WINDOW_ID })
    expect(store.snapshot()).toMatchObject({
      complete: false,
      revision: revision + 1,
      recordsByWorktree: { [WT]: [RECORD] }
    })
  })

  // Minor (m1): a reload that fails (or times out) with no headless fallback.
  it('goes incomplete when a reload fails and no headless graph takes over', () => {
    const { runtime, store } = publishedRuntime()
    runtime.markGraphReloadFailed(1, 'renderer-process-gone')
    expect(store.snapshot().complete).toBe(false)
  })

  // Minor (m2): a degraded startup restored no sessions, so its set is unknown, not empty.
  it('keeps a degraded window’s publication incomplete', () => {
    const runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], rendererGeneration: 'r1' })
    runtime.syncSessionWorkflowRecords(1, {
      rendererGeneration: 'r1',
      recordsByWorktree: {},
      complete: false
    })
    expect(runtime.getSessionWorkflowRecordStore().snapshot().complete).toBe(false)
  })
})
