import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Store } from '../persistence'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { AutomationService } from './service'
import { resolveAutomationRunTarget } from './run-target-resolution'
import type { AutomationPrecheckResult } from '../../shared/automations-types'
import type { WorkspaceLinkedItem } from '../../shared/worktree/types'

const precheck = vi.hoisted(() => vi.fn())
vi.mock('./precheck-runner', () => ({ runAutomationPrecheck: precheck }))

const linkedItem: WorkspaceLinkedItem = {
  provider: 'backoffice',
  type: 'issue',
  number: 1,
  title: 'Reply to a customer',
  url: 'https://app.omnisi.ai',
  hubTaskId: 'btk_customer'
}

describe('automation hub authority', () => {
  let directory: string
  let store: Store
  let service: AutomationService | undefined

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'automation-hub-authority-'))
    vi.resetModules()
    installFakeAppEnvironment({ getPath: () => directory })
    const persistence = await import('../persistence')
    persistence.initDataPath()
    store = new persistence.Store()
    store.addRepo({ id: 'r1', path: '/repo', displayName: 'Repo', badgeColor: '#fff', addedAt: 1 })
    precheck.mockReset()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T08:00:00Z'))
  })

  afterEach(() => {
    service?.stop()
    service = undefined
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  })

  function seed() {
    return store.createAutomation({
      name: 'Customer followup',
      prompt: 'Draft a reply',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      precheck: { command: 'test -f ready', timeoutSeconds: 30 },
      timezone: 'UTC',
      rrule: 'FREQ=HOURLY;BYMINUTE=0',
      dtstart: Date.now() - 3_600_000
    })
  }

  function linkWorkspace() {
    store.setWorktreeMeta('wt1', { linkedWorkItem: linkedItem })
  }

  function passingPrecheck(): AutomationPrecheckResult {
    return {
      command: 'test -f ready',
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      error: null,
      startedAt: Date.now(),
      completedAt: Date.now()
    }
  }

  it('refuses a legacy enabled schedule after its workspace becomes hub linked', async () => {
    const automation = seed()
    linkWorkspace()
    const dispatcher = vi.fn()
    service = new AutomationService(store, { headlessDispatcher: dispatcher })
    vi.setSystemTime(Date.now() + 3_600_000)
    service.start()
    await vi.waitFor(() => expect(store.listAutomationRuns(automation.id)).toHaveLength(1))
    expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
      status: 'skipped_unavailable',
      error: expect.stringContaining('omnios card btk_customer')
    })
    expect(dispatcher).not.toHaveBeenCalled()
    expect(precheck).not.toHaveBeenCalled()
  })

  it('refuses manual dispatch and precheck before running any command', async () => {
    const automation = seed()
    const scheduled = store.createAutomationRun(automation, Date.now() - 1, 'scheduled')
    linkWorkspace()
    const dispatcher = vi.fn()
    service = new AutomationService(store, { headlessDispatcher: dispatcher })
    await expect(service.runNow(automation.id)).resolves.toMatchObject({
      status: 'skipped_unavailable'
    })
    await expect(service.runPrecheck(automation.id, scheduled.id)).resolves.toMatchObject({
      exitCode: null,
      error: expect.stringContaining('omnios card btk_customer')
    })
    expect(dispatcher).not.toHaveBeenCalled()
    expect(precheck).not.toHaveBeenCalled()
  })

  it('rechecks a workspace linked while a scheduled precheck is awaiting completion', async () => {
    const automation = seed()
    let finishPrecheck: ((result: AutomationPrecheckResult) => void) | undefined
    precheck.mockImplementation(
      () =>
        new Promise<AutomationPrecheckResult>((resolve) => {
          finishPrecheck = resolve
        })
    )
    const dispatcher = vi.fn()
    service = new AutomationService(store, { headlessDispatcher: dispatcher })
    vi.setSystemTime(Date.now() + 3_600_000)
    service.start()
    await vi.waitFor(() => expect(precheck).toHaveBeenCalledTimes(1))
    linkWorkspace()
    finishPrecheck!(passingPrecheck())
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
        status: 'dispatch_failed',
        error: expect.stringContaining('omnios card btk_customer')
      })
    )
    expect(dispatcher).not.toHaveBeenCalled()
  })

  it('preserves unbound local scheduled automation', async () => {
    const automation = seed()
    precheck.mockResolvedValue(passingPrecheck())
    const dispatcher = vi.fn().mockResolvedValue({ workspaceId: 'wt1', terminalSessionId: 'tab1' })
    service = new AutomationService(store, { headlessDispatcher: dispatcher })
    vi.setSystemTime(Date.now() + 3_600_000)
    service.start()
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('dispatched')
    )
    expect(precheck).toHaveBeenCalledTimes(1)
    expect(dispatcher).toHaveBeenCalledTimes(1)
  })

  it('uses the captured execution host metadata rather than another host at the same locator', () => {
    const automation = seed()
    store.setWorktreeMetaForHost('wt1', 'ssh:other', { linkedWorkItem: linkedItem })
    expect(resolveAutomationRunTarget(store, automation).ok).toBe(true)
    store.setWorktreeMetaForHost('wt1', 'local', { linkedWorkItem: linkedItem })
    expect(resolveAutomationRunTarget(store, automation)).toMatchObject({
      ok: false,
      error: expect.stringContaining('omnios card btk_customer')
    })
  })

  it('refuses the actual folder-scoped workspace id when its stored row is hub linked', async () => {
    const created = seed()
    const automation = store.updateAutomation(created.id, { workspaceId: 'folder:customer' })
    vi.spyOn(store, 'getFolderWorkspaces').mockReturnValue([
      {
        id: 'customer',
        projectGroupId: 'group',
        name: 'Customers',
        folderPath: '/customers',
        linkedTask: linkedItem,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 1,
        createdAt: 1,
        updatedAt: 1
      }
    ])
    const dispatcher = vi.fn()
    service = new AutomationService(store, { headlessDispatcher: dispatcher })
    await expect(service.runNow(automation.id)).resolves.toMatchObject({
      status: 'skipped_unavailable',
      error: expect.stringContaining('omnios card btk_customer')
    })
    expect(dispatcher).not.toHaveBeenCalled()
  })
})
