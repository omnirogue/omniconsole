import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store, initDataPath } from '../persistence'
import { createAutomationRunWriter } from './automation-run-writer'
import {
  createAutomationDispatchRequest,
  bindAutomationOutputWorkspace,
  matchesAutomationOutputDispatch
} from './automation-output-binding'
import {
  beginAutomationDispatchTokenUse,
  clearAutomationDispatchTokens,
  matchesAutomationLaunchDispatch,
  isAutomationDispatchTokenCurrent
} from './dispatch-tokens'
import type { AutomationRunStatus } from '../../shared/automations-types'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'routine-dispatch-grants-'))
  installFakeAppEnvironment({ getPath: () => directory })
  initDataPath()
  store = new Store()
  store.addRepo({
    id: 'repo-1',
    path: '/repo',
    displayName: 'Routine',
    badgeColor: '#fff',
    addedAt: 1
  })
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => {
  for (const run of store.listAutomationRuns()) {
    clearAutomationDispatchTokens(run.automationId, run.id)
  }
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})
function dispatch(
  newWorkspace = false,
  structured = false,
  captureIncarnation?: Parameters<typeof createAutomationRunWriter>[4]
) {
  const automation = store.createAutomation({
    name: 'Routine',
    prompt: 'private',
    agentId: 'claude',
    projectId: 'repo-1',
    workspaceMode: newWorkspace ? 'new_per_run' : 'existing',
    workspaceId: newWorkspace ? null : 'wt-1',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: Date.now(),
    enabled: false,
    ...(structured
      ? { structuredOutput: { provider: 'typesafe', contract: 'classification.v1' } as const }
      : {})
  })
  const writer = createAutomationRunWriter(store, null, undefined, undefined, captureIncarnation)
  const pending = writer.createRun(automation, Date.now(), 'scheduled')
  const run = writer.updateRun({
    runId: pending.id,
    status: 'dispatching'
  })
  return { writer, ...createAutomationDispatchRequest(store, automation, run) }
}
describe('host routine dispatch provenance grants', () => {
  it('one dispatch write preserves the process incarnation and invalidates its grant', () => {
    const capture = vi.fn(() => 'pty-1:inc-1')
    const request = dispatch(false, false, capture)
    const run = request.writer.updateRun({
      runId: request.run.id,
      status: 'dispatched',
      terminalPaneKey: 'tab-1:leaf-1',
      terminalPtyId: 'pty-1'
    })
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: request.run.id,
        terminalPaneKey: 'tab-1:leaf-1',
        terminalPtyId: 'pty-1'
      })
    )
    expect(run.terminalProcessIncarnation).toBe('pty-1:inc-1')
    expect(store.listAutomationRuns(request.automation.id)[0].terminalProcessIncarnation).toBe(
      'pty-1:inc-1'
    )
    expect(matchesAutomationLaunchDispatch(store, request.launchProvenance, 'wt-1', 'claude')).toBe(
      false
    )
    expect(isAutomationDispatchTokenCurrent(request.launchProvenance!)).toBe(false)
  })

  it.each(['dispatched', 'dispatch_failed', 'skipped_unavailable'] as AutomationRunStatus[])(
    'a committed %s invalidates ordinary and output grants immediately',
    (status) => {
      const request = dispatch(false, true)
      expect(
        matchesAutomationLaunchDispatch(store, request.launchProvenance, 'wt-1', 'claude')
      ).toBe(true)
      expect(matchesAutomationOutputDispatch(store, request.outputBinding, 'wt-1', 'claude')).toBe(
        true
      )
      request.writer.updateRun({
        runId: request.run.id,
        status
      })
      expect(
        matchesAutomationLaunchDispatch(store, request.launchProvenance, 'wt-1', 'claude')
      ).toBe(false)
      expect(matchesAutomationOutputDispatch(store, request.outputBinding, 'wt-1', 'claude')).toBe(
        false
      )
      expect(isAutomationDispatchTokenCurrent(request.launchProvenance!)).toBe(false)
      expect(isAutomationDispatchTokenCurrent(request.outputBinding!)).toBe(false)
    }
  )
  it('scope and expiry reject unrelated claims while repeated reads preserve output token use', () => {
    const request = dispatch(false, true)
    for (let index = 0; index < 2; index++) {
      expect(
        matchesAutomationLaunchDispatch(store, request.launchProvenance, 'wt-1', 'claude')
      ).toBe(true)
      expect(matchesAutomationOutputDispatch(store, request.outputBinding, 'wt-1', 'claude')).toBe(
        true
      )
    }
    expect(
      matchesAutomationLaunchDispatch(store, request.launchProvenance, 'other-workspace', 'claude')
    ).toBe(false)
    expect(matchesAutomationLaunchDispatch(store, request.launchProvenance, 'wt-1', 'codex')).toBe(
      false
    )
    expect(
      matchesAutomationLaunchDispatch(
        { listAutomationRuns: () => store.listAutomationRuns() },
        request.launchProvenance,
        'wt-1',
        'claude'
      )
    ).toBe(false)
    expect(
      beginAutomationDispatchTokenUse({ ...request.outputBinding!, reservationId: 'binding' })
    ).toBe(true)
    expect(
      beginAutomationDispatchTokenUse({
        ...request.launchProvenance!,
        reservationId: 'description'
      })
    ).toBe(true)
    vi.setSystemTime(Date.now() + 30 * 60_000)
    expect(matchesAutomationLaunchDispatch(store, request.launchProvenance, 'wt-1', 'claude')).toBe(
      false
    )
    expect(matchesAutomationOutputDispatch(store, request.outputBinding, 'wt-1', 'claude')).toBe(
      false
    )
  })
  it('a new-workspace grant gains only the workspace created under its dispatch token', () => {
    const request = dispatch(true)
    const provenance = {
      automationId: request.automation.id,
      automationRunId: request.run.id,
      dispatchToken: request.dispatchToken,
      createRequestId: 'create-request'
    }
    expect(
      matchesAutomationLaunchDispatch(store, request.launchProvenance, 'wt-new', 'claude')
    ).toBe(false)
    bindAutomationOutputWorkspace(store, { ...provenance, dispatchToken: 'forged' }, 'wt-new')
    expect(
      matchesAutomationLaunchDispatch(store, request.launchProvenance, 'wt-new', 'claude')
    ).toBe(false)
    bindAutomationOutputWorkspace(store, provenance, 'wt-new')
    expect(
      matchesAutomationLaunchDispatch(store, request.launchProvenance, 'wt-new', 'claude')
    ).toBe(true)
    bindAutomationOutputWorkspace(store, provenance, 'wt-forged')
    expect(
      matchesAutomationLaunchDispatch(store, request.launchProvenance, 'wt-forged', 'claude')
    ).toBe(false)
  })
})
