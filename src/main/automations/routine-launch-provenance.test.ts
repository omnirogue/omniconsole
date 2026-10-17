import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { AutomationDispatchRequest } from '../../shared/automations-types'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { AutomationService } from './service'
import { Store, initDataPath } from '../persistence'
import { runPtyIpcSpawn } from '../ipc/pty/ipc/spawn-run'
import { registerLaunchLedgerTestDirectory } from '../launch-ledger/launch-ledger-test-directory'
import { findLaunchHistory } from '../launch-ledger/launch-ledger'
import { ledgerIdentifier } from '../launch-ledger/launch-ledger-identifiers'
import type { PtyIpcSpawnState } from '../ipc/pty/ipc/spawn-state'

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  execute: vi.fn(),
  paste: vi.fn(async () => true)
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => fixture.state, subscribe: () => () => {} }
}))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: fixture.paste }))
vi.mock('@/lib/agent-launch-platform', () => ({ getAgentLaunchPlatformForRepo: () => 'linux' }))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: () => ({ drain: () => {}, release: () => {} }),
  subscribeToPtyExit: () => () => {}
}))
vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: () => () => {}
}))
vi.mock('../ipc/pty/provider/registry', () => ({ localProvider: {} }))
vi.mock('../ipc/pty/ipc/interrupted-resume', () => ({ prepareInterruptedResume: () => null }))
vi.mock('../ipc/pty/ipc/spawn-begin', () => ({ beginPtyIpcSpawn: async () => null }))
vi.mock('../ipc/pty/ipc/spawn-preflight', () => ({ preparePtyIpcSpawnPreflight: async () => {} }))
vi.mock('../ipc/pty/ipc/spawn-env', () => ({
  assemblePtyIpcSpawnEnv: async (ctx: PtyIpcSpawnState) => {
    ctx.launchCommand = ctx.args.command
  }
}))
vi.mock('../ipc/pty/ipc/spawn-execute', () => ({
  executePtyIpcSpawn: async (ctx: PtyIpcSpawnState) => {
    fixture.execute()
    ctx.result = { id: 'pty-1', incarnationId: '33333333-3333-4333-8333-333333333333' }
  }
}))
vi.mock('../ipc/pty/ipc/spawn-commit', () => ({
  commitPtyIpcSpawn: async (ctx: PtyIpcSpawnState) => ctx.result
}))

const rows = registerLaunchLedgerTestDirectory()
let directory: string
let service: AutomationService | undefined
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'routine-provenance-'))
  installFakeAppEnvironment({ getPath: () => directory })
  initDataPath()
  fixture.execute.mockClear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-03T08:59:00.000Z'))
})
afterEach(() => {
  service?.stop()
  service = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
  rmSync(directory, { recursive: true, force: true })
})

async function renderer(store: Store) {
  // Load actual renderer dispatch and launch code without crossing the node project's static imports.
  const stateModule = '../../renderer/src/lib/agent-background-session-test-state'
  const { createAgentBackgroundSessionTestState, resetAgentBackgroundSessionTestHarness } =
    await import(stateModule)
  const mocks = Object.fromEntries(
    [
      'createTab',
      'setTabCustomTitle',
      'updateTabPtyId',
      'closeTab',
      'setTabLayout',
      'registerAgentLaunchConfig',
      'spawn',
      'write',
      'kill',
      'markTrusted',
      'dispatchEvent',
      'getLaunchPlatform',
      'runtimeCall',
      'runtimeTransportCall',
      'runtimeSubscribe',
      'subscribeToData',
      'subscribeToExit'
    ].map((key) => [key, vi.fn()])
  )
  const state = createAgentBackgroundSessionTestState(mocks)
  resetAgentBackgroundSessionTestHarness({ ...mocks, state })
  mocks.runtimeCall.mockImplementation(({ method, params }) => ({
    ok: true,
    result:
      method === 'automation.runs'
        ? { runs: store.listAutomationRuns(params.automationId) }
        : { terminal: { handle: 'terminal-1', worktreeId: 'wt-1', title: null } }
  }))
  fixture.state = {
    ...state,
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {},
    agentLaunchConfigByPaneKey: {}
  }
  mocks.spawn.mockImplementation((args) =>
    runPtyIpcSpawn({ store, getSettings: () => ({ restoreFloodGuard: false }) } as never, args)
  )
  Object.assign(window.api, {
    runtime: { call: mocks.runtimeCall },
    automations: {
      markDispatchResult: (result: never) => service!.markDispatchResult(result),
      runPrecheck: async () => null
    }
  })
  const handlerModule = '../../renderer/src/hooks/automation-dispatch-handler'
  const { handleAutomationDispatchRequest } = await import(handlerModule)
  return { mocks, handleAutomationDispatchRequest }
}

function scheduledAutomation(store: Store) {
  store.addRepo({
    id: 'repo-1',
    path: '/repo',
    displayName: 'Routine test',
    badgeColor: '#fff',
    addedAt: 1
  })
  return store.createAutomation({
    name: 'Ordinary routine',
    prompt: 'Private routine prompt',
    agentId: 'claude',
    projectId: 'repo-1',
    workspaceMode: 'existing',
    workspaceId: 'wt-1',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: Date.parse('2026-10-02T00:00:00.000Z'),
    enabled: true
  })
}
const hash = (id: string) => `hash_${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
describe('ordinary scheduled routine launch provenance', () => {
  it('real desktop dispatch without structured output records one automation row and explains its run', async () => {
    const store = new Store()
    const automation = scheduledAutomation(store)
    expect(automation.structuredOutput).toBeUndefined()
    const { mocks, handleAutomationDispatchRequest } = await renderer(store)
    let dispatched: Promise<void> | undefined
    let payload: AutomationDispatchRequest | undefined
    let noteSent!: () => void
    const sent = new Promise<void>((resolve) => {
      noteSent = resolve
    })
    const send = vi.fn((_channel: string, request: AutomationDispatchRequest) => {
      payload = request
      dispatched = handleAutomationDispatchRequest(request)
      noteSent()
    })
    service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({ isDestroyed: () => false, send } as never)
    service.setRendererReady()
    const ts = new Date(automation.nextRunAt + 60_000).toISOString()
    vi.setSystemTime(new Date(ts))
    service.start()
    await sent
    expect(send).toHaveBeenCalledOnce()
    await dispatched
    const run = store.listAutomationRuns(automation.id)[0]
    expect(run.trigger).toBe('scheduled')
    expect(run.status, run.error ?? undefined).toBe('dispatched')
    expect(fixture.execute).toHaveBeenCalledOnce()
    const args = mocks.spawn.mock.calls[0][0]
    const recorded = await rows()
    expect(recorded).toEqual([
      {
        v: 1,
        ts,
        launchId: expect.any(String),
        pipeline: 'renderer-ipc',
        ptyId: 'pty-1',
        incarnationId: '33333333-3333-4333-8333-333333333333',
        paneKey: `${args.tabId}:${args.leafId}`,
        tabId: args.tabId,
        worktreeId: ledgerIdentifier('worktreeId', 'wt-1'),
        agent: 'claude',
        cause: 'automation',
        reference: { automationId: automation.id, automationRunId: run.id },
        actor: { kind: 'renderer' },
        claimedTrigger: 'automation',
        claimedReferenceHashes: {
          automationId: hash(automation.id),
          automationRunId: hash(run.id)
        },
        hasStartupCommand: true,
        visible: false,
        process: 'created'
      }
    ])
    expect(JSON.stringify(recorded)).not.toContain('Private routine prompt')
    expect(payload).not.toHaveProperty('outputBinding')
    expect(JSON.stringify(recorded)).not.toContain(payload!.launchProvenance!.token)
    const why = await findLaunchHistory({
      ptyId: 'pty-1',
      incarnationId: recorded[0].incarnationId
    })
    const formatterModule = '../../cli/terminal-why-format'
    const { formatTerminalWhy } = await import(formatterModule)
    const text = formatTerminalWhy({
      why: { terminal: 'term_test', ptyId: 'pty-1', paneKey: recorded[0].paneKey!, ...why }
    })
    expect(text).toBe(
      `This terminal started for automation, requested by renderer at ${ts} (automationId ${automation.id}, automationRunId ${run.id}); claimed cause automation; claimed automationId ${hash(automation.id)}; claimed automationRunId ${hash(run.id)}.`
    )
    await runPtyIpcSpawn(
      { store, getSettings: () => ({ restoreFloodGuard: false }) } as never,
      args
    )
    const laterRows = await rows()
    const { reference: _owner, ...claimedRow } = recorded[0]
    expect(laterRows).toEqual([
      recorded[0],
      {
        ...claimedRow,
        launchId: expect.any(String),
        cause: 'renderer-spawn'
      }
    ])
    expect(fixture.execute).toHaveBeenCalledTimes(2)
  })
})
