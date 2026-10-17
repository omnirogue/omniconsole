import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AutomationRun } from '../../shared/automations-types'
import { AutomationService } from './service'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const testState = { dir: '' }
const PANE_KEY = 'tab-c:5f0c7b1e-8a1d-4f55-9a52-2b7d4a3c9e10'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

async function createStore() {
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return new Store()
}

async function serviceWithAutomation() {
  const store = await createStore()
  store.addRepo({ id: 'r1', path: '/repo', displayName: 'test', badgeColor: '#fff', addedAt: 1 })
  const automation = store.createAutomation({
    name: 'Session cleanup',
    prompt: 'Clean up',
    agentId: 'claude',
    projectId: 'r1',
    workspaceMode: 'existing',
    workspaceId: 'wt1',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-09-26T00:00:00Z').getTime(),
    enabled: false
  })
  const service = new AutomationService(store, { tickMs: 60_000 })
  service.setWebContents({ isDestroyed: () => false, send: vi.fn() } as never)
  service.setRendererReady()
  return { store, service, automation }
}

describe('AutomationService run triggers', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'omni-automation-trigger-'))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-25T08:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('records a run the app starts by itself as automatic, and a click as manual', async () => {
    const { store, service, automation } = await serviceWithAutomation()

    const automatic = await service.runNow(automation.id, {
      trigger: 'automatic',
      promptOverride: 'brief'
    })
    // Why: a disabled automation still runs on demand, the way the cleanup automation is used.
    expect(automatic.status).toBe('dispatching')
    await service.markDispatchResult({ runId: automatic.id, status: 'completed' })
    vi.setSystemTime(new Date('2026-09-25T08:05:00Z'))
    const manual = await service.runNow(automation.id)

    const byId = new Map(store.listAutomationRuns(automation.id).map((run) => [run.id, run]))
    expect(byId.get(automatic.id)?.trigger).toBe('automatic')
    expect(byId.get(automatic.id)?.promptOverride).toBe('brief')
    expect(byId.get(manual.id)?.trigger).toBe('manual')
  })

  it('returns the live run instead of starting a second one while it is still running', async () => {
    const { store, service, automation } = await serviceWithAutomation()

    const first = await service.runNow(automation.id)
    vi.setSystemTime(new Date('2026-09-25T08:05:00Z'))
    const second = await service.runNow(automation.id)
    await service.markDispatchResult({ runId: first.id, status: 'dispatched' })
    const third = await service.runNow(automation.id)

    expect(second.id).toBe(first.id)
    expect(third.id).toBe(first.id)
    expect(store.listAutomationRuns(automation.id)).toHaveLength(1)
  })

  it('tells observers every dispatch result as written, until they stop observing', async () => {
    const { service, automation } = await serviceWithAutomation()
    const seen: Pick<AutomationRun, 'id' | 'status' | 'terminalPaneKey'>[] = []
    const stop = service.observeRuns((run) =>
      seen.push({ id: run.id, status: run.status, terminalPaneKey: run.terminalPaneKey })
    )
    const run = await service.runNow(automation.id, { trigger: 'automatic' })

    await service.markDispatchResult({
      runId: run.id,
      status: 'dispatched',
      terminalPaneKey: PANE_KEY,
      terminalPtyId: 'pty-1'
    })
    await service.markDispatchResult({ runId: run.id, status: 'dispatch_failed', error: 'x' })
    stop()
    await service.markDispatchResult({ runId: run.id, status: 'dispatch_failed', error: 'y' })

    expect(seen).toEqual([
      { id: run.id, status: 'dispatched', terminalPaneKey: PANE_KEY },
      { id: run.id, status: 'dispatch_failed', terminalPaneKey: PANE_KEY }
    ])
  })
})
