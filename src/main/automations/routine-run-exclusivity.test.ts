import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Store } from '../persistence'
import type { Automation } from '../../shared/automations-types'
import { AutomationService } from './service'
import { ROUTINE_RUN_IN_PROGRESS } from './routine-run-exclusivity'
import type { AutomationRunTerminalObserver } from './run-completion-watcher'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

async function createStore(): Promise<Store> {
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store: StoreClass, initDataPath } = await import('../persistence')
  initDataPath()
  return new StoreClass()
}

function seedHourlyRoutine(store: Store): Automation {
  store.addRepo({ id: 'r1', path: '/repo', displayName: 'test', badgeColor: '#fff', addedAt: 1 })
  return store.createAutomation({
    name: 'Hourly check',
    prompt: 'Check the repo',
    agentId: 'claude',
    projectId: 'r1',
    workspaceMode: 'existing',
    workspaceId: 'wt1',
    timezone: 'UTC',
    rrule: 'FREQ=HOURLY;BYMINUTE=0',
    dtstart: new Date('2026-05-12T00:00:00Z').getTime()
  })
}

function attach(service: AutomationService, send = vi.fn()): typeof send {
  service.setWebContents({ isDestroyed: () => false, send } as never)
  return send
}

async function evaluateAt(store: Store, service: AutomationService, when: string): Promise<void> {
  const nextRunAt = (): number => store.listAutomations()[0]!.nextRunAt
  const before = nextRunAt()
  vi.setSystemTime(new Date(when))
  await (service as unknown as { evaluateDueRuns(): Promise<void> }).evaluateDueRuns()
  await vi.waitFor(() => expect(nextRunAt()).toBeGreaterThan(before))
}

describe('a routine runs at most once at a time', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'omni-routine-exclusivity-'))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T08:30:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('skips occurrences while the previous run still holds its session, folding them', async () => {
    const store = await createStore()
    const automation = seedHourlyRoutine(store)
    const service = new AutomationService(store, { tickMs: 60_000 })
    const send = attach(service)
    service.setRendererReady()

    await evaluateAt(store, service, '2026-05-13T09:01:00Z')
    const [first] = store.listAutomationRuns(automation.id)
    await service.markDispatchResult({ runId: first!.id, status: 'dispatched' })
    await evaluateAt(store, service, '2026-05-13T10:01:00Z')
    await evaluateAt(store, service, '2026-05-13T11:01:00Z')

    const runs = store.listAutomationRuns(automation.id)
    expect(send).toHaveBeenCalledTimes(1)
    expect(runs.map((run) => run.status)).toEqual(['skipped_unavailable', 'dispatched'])
    expect(runs[0]).toMatchObject({ error: ROUTINE_RUN_IN_PROGRESS, occurrenceCount: 2 })
    service.stop()
  })

  it('never re-dispatches an occurrence that was launched before a restart', async () => {
    const store = await createStore()
    const automation = seedHourlyRoutine(store)
    vi.setSystemTime(new Date('2026-05-13T09:01:00Z'))
    const scheduledFor = new Date('2026-05-13T09:00:00Z').getTime()
    // The previous process launched it and quit before advancing nextRunAt.
    const launched = store.createAutomationRun(automation, scheduledFor)
    store.updateAutomationRun({ runId: launched.id, status: 'dispatched', workspaceId: 'wt1' })

    const service = new AutomationService(store, { tickMs: 60_000 })
    const send = attach(service)
    service.setRendererReady()
    await vi.waitFor(() =>
      expect(store.listAutomations()[0]!.nextRunAt).toBe(new Date('2026-05-13T10:00:00Z').getTime())
    )

    expect(send).not.toHaveBeenCalled()
    expect(store.listAutomationRuns(automation.id)).toEqual([
      expect.objectContaining({ id: launched.id, status: 'dispatched' })
    ])
    service.stop()
  })

  it('does not reopen a settled run when a late dispatch result arrives', async () => {
    const store = await createStore()
    const automation = seedHourlyRoutine(store)
    const run = store.createAutomationRun(automation, Date.now(), 'manual')
    store.updateAutomationRun({ runId: run.id, status: 'dispatch_failed', error: 'stranded' })

    const late = store.updateAutomationRun({ runId: run.id, status: 'dispatched' })

    expect(late.status).toBe('dispatch_failed')
    expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('dispatch_failed')
  })

  it('hands dispatches a reloaded renderer dropped to reconciliation', async () => {
    const store = await createStore()
    const automation = seedHourlyRoutine(store)
    const observer: AutomationRunTerminalObserver = {
      resolveRunTerminal: vi.fn(() => null),
      observeCompletion: vi.fn(() => new Promise<never>(() => {}))
    }
    const service = new AutomationService(store, { tickMs: 60_000, terminalObserver: observer })
    attach(service)
    service.setRendererReady()
    const run = await service.runNow(automation.id)
    expect(run.status).toBe('dispatching')
    expect(observer.resolveRunTerminal).not.toHaveBeenCalled()

    // Reload: same window, the new renderer announces itself again.
    service.setRendererReady()

    expect(observer.resolveRunTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ id: run.id, status: 'dispatching' })
    )
    service.stop()
  })

  it('keeps a reload-unverified dispatch exclusive until its owner reports an outcome', async () => {
    const store = await createStore()
    const automation = seedHourlyRoutine(store)
    const observer: AutomationRunTerminalObserver = {
      resolveRunTerminal: vi.fn(() => null),
      observeCompletion: vi.fn(() => new Promise<never>(() => {}))
    }
    const service = new AutomationService(store, { terminalObserver: observer })
    attach(service)
    service.setRendererReady()
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000)
    const run = await service.runNow(automation.id)

    service.setRendererReady()
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000)

    expect(
      store.listAutomationRuns(automation.id).find((entry) => entry.id === run.id)?.status
    ).toBe('dispatching')
    expect((await service.runNow(automation.id)).id).toBe(run.id)
    await service.markDispatchResult({ runId: run.id, status: 'completed' })
    await vi.advanceTimersByTimeAsync(1)
    expect((await service.runNow(automation.id)).id).not.toBe(run.id)
    service.stop()
  })
})
