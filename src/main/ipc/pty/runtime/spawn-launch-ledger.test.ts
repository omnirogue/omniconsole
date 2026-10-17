import { reservePaneSpawn, paneSpawnReservationsByOwnerKey } from '../pane/spawn-reservation'
import * as provenance from '../../../launch-ledger/spawn-launch-record'
import { prepareRuntimeSpawnLaunch } from '../../../launch-ledger/spawn-launch-record'
import type * as SpawnExecution from './spawn-execute'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Why: an agent start from the runtime controller (CLI, phone, orchestration) can wait minutes
// for an app-wide admission slot. The worktree terminal-install token is the worktree-removal
// fence, so it must be taken only once the start is admitted — a queued start must not stall a
// worktree deletion, nor land in a worktree that was removed while it waited.

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  count: 0,
  reattach: false,
  incarnationId: undefined as string | undefined,
  fail: false,
  early: null as 'materialized' | 'preflight' | 'reservation' | null,
  adopted: false,
  exited: false,
  actualExecute: false,
  provider: {
    spawn: vi.fn(async (_options: unknown) => {
      if (state.fail) {
        throw new Error('provider refused')
      }
      return {
        id: `pty-${++state.count}`,
        isReattach: state.reattach,
        ...(state.incarnationId ? { incarnationId: state.incarnationId } : {}),
        ...(state.exited ? { exitedBeforeSpawnReply: true } : {}),
        ...(state.adopted ? { agentSessionEnsure: { disposition: 'adopted' } } : {})
      }
    })
  }
}))

vi.mock('../provider/registry', () => ({ localProvider: {} }))
vi.mock('../../../providers/local-pty-provider', () => ({ LocalPtyProvider: class {} }))
vi.mock('../delivery/spawn-geometry', () => ({
  beginPtySpawnGeometry: () => null,
  restorePtySpawnGeometry: () => {}
}))
vi.mock('../host-env/codex-home', () => ({ CODEX_HOME_ENV_KEYS: [] }))
vi.mock('../host-env/pi-agent', () => ({
  mergePtyEnvDeletions: (...lists: (string[] | undefined)[]) => lists.flatMap((list) => list ?? []),
  removeCodexHomeDeletionRequests: (keys: string[] | undefined) => keys,
  getInheritedAgentHookEnvKeysToDelete: () => [],
  getInheritedClaudeSessionStampEnvKeysToDelete: () => []
}))
vi.mock('../host-env/path', () => ({
  promoteAgentTeamsShimPath: () => {},
  deleteRequestedEnvKeys: () => {}
}))
vi.mock('../host-env/fresh-spawn-routing', () => ({
  routesFreshSpawnsToLocalProvider: () => false,
  beginPtySpawnForWorktree: vi.fn(() => {
    return () => {}
  })
}))
vi.mock('../../../claude-accounts/environment', () => ({ CLAUDE_AUTH_ENV_VARS: [] }))
vi.mock('../../../pty/legacy-terminal-shim-dir', () => ({
  LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS: []
}))
vi.mock('../pane/stable-owner', () => ({
  resolveStablePaneOwner: () => null,
  spawnForStablePane: async ({
    provider,
    spawnOptions
  }: {
    provider: typeof state.provider
    spawnOptions: unknown
  }) => ({ result: await provider.spawn(spawnOptions), owner: null })
}))
vi.mock('../../terminal-startup-color-query-replies', () => ({
  getStartupTerminalColorQueryReplyColors: () => null
}))
vi.mock('../pane/resume-task-link', () => ({ carryResumedTaskForSpawn: async () => {} }))
vi.mock('./spawn-reply', () => ({ toRuntimeSpawnReply: (reply: unknown) => reply }))
vi.mock('./spawn-early', () => ({
  adoptMaterializedRuntimePtySpawn: () => (state.early === 'materialized' ? { id: 'pty-99' } : null)
}))
vi.mock('./spawn-preflight', () => ({
  prepareRuntimePtySpawn: async (ctx: {
    args: { command?: string }
    launchCommand?: string
    cwd?: string
    provider: unknown
  }) => {
    ctx.launchCommand = ctx.args.command
    ctx.cwd = '/tmp/wt'
    ctx.provider = state.provider
    return state.early === 'preflight' ? { id: 'pty-99' } : null
  }
}))
vi.mock('./spawn-execute', () => ({
  executeRuntimePtySpawn: async (ctx: { result: unknown; spawnOptions: unknown }) => {
    state.execute(ctx)
    if (state.actualExecute) {
      const actual = await vi.importActual<typeof SpawnExecution>('./spawn-execute')
      await actual.executeRuntimePtySpawn(ctx as never)
    } else {
      prepareRuntimeSpawnLaunch(ctx as never)
      ctx.result = await state.provider.spawn(ctx.spawnOptions as never)
    }
  }
}))
vi.mock('./spawn-commit', () => ({
  commitRuntimePtySpawn: async (ctx: { result: unknown }) => ctx.result
}))
vi.mock('../../../pty/hub-task-launch-admission', () => ({
  assertUnboundHubTerminalLaunch: () => {}
}))
vi.mock('../pane/launch-authority', () => ({ getDeclaredLaunchHubTaskId: () => undefined }))
vi.mock('../../../runtime/new-agent-session-command-defaults', () => ({
  resolveNewAgentSessionCommandDefaults: async (args: { command?: string }) => args.command
}))
vi.mock('../agent-launch-admission-gate', () => ({
  isLivePtyReattach: () => false,
  gatePtySpawnAgentLaunch: async () => {}
}))
import { spawnPtyFromRuntimeController } from './spawn'
import { registerLaunchLedgerTestDirectory } from '../../../launch-ledger/launch-ledger-test-directory'
import { setLatencyTelemetryEnabledReader } from '../../../observability/latency-probe-switch'
const readRows = registerLaunchLedgerTestDirectory()
beforeEach(async () => {
  state.execute.mockReset()
  state.count = 0
  state.incarnationId = undefined
  state.reattach = false
  state.fail = false
  state.early = null
  state.adopted = false
  state.exited = false
  state.actualExecute = false
  state.provider.spawn.mockClear()
})
const deps = { getSettings: () => ({}) }
async function spawn(extra: Record<string, unknown> = {}, extraDeps: Record<string, unknown> = {}) {
  return spawnPtyFromRuntimeController(
    { ...deps, ...extraDeps } as never,
    {
      cols: 80,
      rows: 24,
      worktreeId: 'folder:99999999-9999-4999-8999-999999999999',
      command: 'claude',
      launchAgent: 'claude',
      ...extra
    } as never
  )
}

const expectedRow = {
  v: 1,
  launchId: expect.stringMatching(/^[0-9a-f-]{36}$/),
  ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  pipeline: 'runtime-controller',
  ptyId: 'pty-1',
  worktreeId: 'folder:99999999-9999-4999-8999-999999999999',
  agent: 'claude',
  cause: 'unknown',
  hasStartupCommand: true,
  visible: false,
  process: 'created'
}
describe('runtime controller durable launch provenance', async () => {
  it('records exactly one created row for each of three admitted spawns', async () => {
    for (let i = 0; i < 3; i++) {
      await spawn()
    }
    expect(await readRows()).toEqual([1, 2, 3].map((i) => ({ ...expectedRow, ptyId: `pty-${i}` })))
  })
  it('retains daemon incarnations on created and attached runtime receipts', async () => {
    state.incarnationId = '33333333-3333-4333-8333-333333333333'
    await spawn()
    state.reattach = true
    await spawn()
    expect(await readRows()).toEqual([
      { ...expectedRow, incarnationId: state.incarnationId },
      { ...expectedRow, ptyId: 'pty-2', process: 'attached', incarnationId: state.incarnationId }
    ])
  })
  it('real headless dispatch without structured output receives a grant and records one routine row', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { installFakeAppEnvironment } =
      await import('../../../../../config/scripts/vitest-host-ports-setup')
    const directory = mkdtempSync(join(tmpdir(), 'headless-routine-provenance-'))
    installFakeAppEnvironment({ getPath: () => directory })
    const { Store, initDataPath } = await import('../../../persistence')
    const { AutomationService } = await import('../../../automations/service')
    initDataPath()
    const store = new Store()
    store.addRepo({
      id: 'repo-1',
      path: '/repo',
      displayName: 'Routine',
      badgeColor: '#fff',
      addedAt: 1
    })
    const automation = store.createAutomation({
      name: 'Ordinary routine',
      prompt: 'routine',
      agentId: 'claude',
      projectId: 'repo-1',
      workspaceMode: 'existing',
      workspaceId: 'wt-1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: Date.now(),
      enabled: true
    })
    const { matchesAutomationLaunchDispatch } = await import('../../../automations/dispatch-tokens')
    let grant: Parameters<typeof matchesAutomationLaunchDispatch>[1]
    const service = new AutomationService(store, {
      headlessDispatcher: async (request) => {
        grant = request.launchProvenance
        expect(matchesAutomationLaunchDispatch(store, grant, 'wt-1', 'claude')).toBe(true)
        expect.soft(request).toMatchObject({
          launchProvenance: {
            automationId: automation.id,
            runId: request.run.id,
            token: expect.any(String)
          }
        })
        await spawn({
          worktreeId: 'wt-1',
          launchCause: {
            trigger: 'automation',
            reference: { automationId: automation.id, automationRunId: request.run.id }
          }
        })
        return { workspaceId: 'wt-1', terminalSessionId: null, terminalPtyId: 'pty-1' }
      }
    })
    try {
      expect(automation.structuredOutput).toBeUndefined()
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(automation.nextRunAt + 60_000)
      service.start()
      await vi.waitFor(() =>
        expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('dispatched')
      )
      const run = store.listAutomationRuns(automation.id)[0]
      expect(run.trigger).toBe('scheduled')
      expect(run.status).toBe('dispatched')
      expect(matchesAutomationLaunchDispatch(store, grant, 'wt-1', 'claude')).toBe(false)
      expect(state.provider.spawn).toHaveBeenCalledOnce()
      const { ledgerIdentifier } = await import('../../../launch-ledger/launch-ledger-identifiers')
      expect(await readRows()).toEqual([
        {
          ...expectedRow,
          worktreeId: ledgerIdentifier('worktreeId', 'wt-1'),
          cause: 'automation',
          actor: { kind: 'app' },
          reference: { automationId: automation.id, automationRunId: run.id }
        }
      ])
    } finally {
      service.stop()
      vi.useRealTimers()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('records a plain shell without an agent', async () => {
    await spawn({ command: undefined, launchAgent: undefined })
    const { agent: _agent, ...shellRow } = expectedRow
    expect(await readRows()).toEqual([{ ...shellRow, hasStartupCommand: false }])
  })
  it('records provider reattach as attached', async () => {
    state.reattach = true
    await spawn()
    expect(await readRows()).toEqual([{ ...expectedRow, process: 'attached' }])
  })
  it('carries capacity recovery ownership and parent', async () => {
    await spawn({
      launchCause: {
        trigger: 'capacity-recovery',
        reference: {
          recoveryId:
            'capacity-recovery:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        },
        parentPaneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'
      }
    })
    expect(await readRows()).toEqual([
      {
        ...expectedRow,
        cause: 'capacity-recovery',
        actor: { kind: 'app' },
        reference: {
          recoveryId:
            'capacity-recovery:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        },
        parentPaneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'
      }
    ])
  })
  it('carries orchestration task and dispatch ids', async () => {
    await spawn({
      launchCause: {
        trigger: 'orchestration-worker',
        reference: {
          orchestrationTaskId: 'task_111111111111',
          orchestrationDispatchId: 'ctx_222222222222'
        }
      }
    })
    expect(await readRows()).toEqual([
      {
        ...expectedRow,
        cause: 'orchestration-worker',
        actor: { kind: 'app' },
        reference: {
          orchestrationTaskId: 'task_111111111111',
          orchestrationDispatchId: 'ctx_222222222222'
        }
      }
    ])
  })
  it('records unknown and warns once when the creator omits its cause', async () => {
    await spawn()
    expect((await readRows()).map((row) => row.cause)).toEqual(['unknown'])
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[launch-ledger\].*runtime-controller/)
    )
  })
  it('records spawns with telemetry switched off', async () => {
    setLatencyTelemetryEnabledReader(() => false)
    await spawn()
    expect((await readRows()).map((row) => row.ptyId)).toEqual(['pty-1'])
  })
  it.each(['materialized', 'preflight'] as const)(
    'records one attached row for %s adoption',
    async (early) => {
      state.early = early
      await spawn()
      expect(await readRows()).toEqual([
        { ...expectedRow, ptyId: 'pty-99', process: 'attached', intent: 'attach' }
      ])
      expect(state.provider.spawn).not.toHaveBeenCalled()
    }
  )
  it('records a claimed existing agent session as attached', async () => {
    state.adopted = true
    await spawn()
    expect(await readRows()).toEqual([{ ...expectedRow, process: 'attached' }])
  })
  it('records the real provider receipt even when the process exits before its reply', async () => {
    state.actualExecute = true
    state.exited = true
    await expect(spawn()).rejects.toThrow('agent_session_exited_during_start')
    expect(state.provider.spawn).toHaveBeenCalledOnce()
    expect(await readRows(true)).toEqual([
      { ...expectedRow, ptyId: null, process: 'prepared' },
      { ...expectedRow, ptyId: 'pty-1', process: 'created' }
    ])
    expect((await readRows(true))[0].launchId).toBe((await readRows(true))[1].launchId)
  })
  it('records a successful call and uncertainty for a provider without a receipt', async () => {
    await spawn()
    state.fail = true
    await expect(spawn()).rejects.toThrow('provider refused')
    expect((await readRows()).map((row) => [row.ptyId, row.process])).toEqual([
      ['pty-1', 'created'],
      [null, 'unknown']
    ])
  })
})

describe('execution timing and attachment intent', () => {
  it('takes preparation time only after acquiring the execution mutex', async () => {
    state.actualExecute = true
    let release = () => {}
    let entered = () => {}
    const acquired = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = spawn(
      {},
      {
        runtime: {
          acquireWorktreeTerminalSpawn: async () => {
            entered()
            await gate
            return () => {}
          }
        }
      }
    )
    await acquired
    let afterWait = 0
    try {
      expect(await readRows(true)).toEqual([])
      afterWait = Date.now()
    } finally {
      release()
      await pending
    }
    const rows = await readRows(true)
    expect(rows.map((row) => row.process)).toEqual(['prepared', 'created'])
    expect(Date.parse(rows[0].ts)).toBeGreaterThanOrEqual(afterWait)
  })
  it('records an existing session request as attachment intent before its receipt', async () => {
    state.reattach = true
    await spawn({ sessionId: '11111111-1111-4111-8111-111111111111' })
    const rows = await readRows(true)
    expect(rows[0]).toMatchObject({ process: 'attachment-intent', intent: 'attach' })
    expect(rows[1]).toMatchObject({ process: 'attached', intent: 'attach' })
  })
})

describe('runtime provenance cannot change execution', () => {
  it.each(['prepareRuntimeSpawnLaunch', 'recordRuntimeSpawnLaunch'] as const)(
    'a throwing %s does not change the real execution result',
    async (name) => {
      state.actualExecute = true
      const baseline = await spawn()
      state.count = 0
      vi.spyOn(provenance, name).mockImplementation(() => {
        throw new Error('private recorder failure')
      })
      await expect(spawn()).resolves.toEqual(baseline)
    }
  )

  it('returns the same spawn and an unknown cause when cause field resolution throws', async () => {
    const baseline = await spawn()
    state.count = 0
    const launchCause = Object.defineProperty({ trigger: 'cli' }, 'actor', {
      enumerable: true,
      get() {
        throw new Error('private cause resolution failure')
      }
    })
    await expect(spawn({ launchCause })).resolves.toEqual(baseline)
    expect((await readRows()).at(-1)).toMatchObject({ ptyId: baseline.id, cause: 'unknown' })
    expect(console.warn).toHaveBeenCalledWith(
      '[launch-ledger] runtime-controller: provenance unavailable'
    )
  })

  it('preserves the provider error and registration cleanup when the failure recorder throws', async () => {
    const error = new Error('provider original error')
    const cancel = vi.fn()
    const release = vi.fn()
    const finish = vi.fn()
    const reservation = reservePaneSpawn('provenance-runtime-cleanup')
    state.execute.mockImplementation((ctx) => {
      ctx.paneSpawnReservationKey = 'provenance-runtime-cleanup'
      ctx.paneSpawnReservation = reservation
      ctx.pendingRegistrationPtyId = 'pending'
      ctx.releaseWorktreeSpawn = release
      ctx.finishTerminalInstall = finish
    })
    state.provider.spawn.mockRejectedValueOnce(error)
    vi.spyOn(provenance, 'recordSpawnLaunchFailure').mockImplementation(() => {
      throw new Error('private recorder failure')
    })
    await expect(spawn({}, { runtime: { cancelPendingPtyRegistration: cancel } })).rejects.toBe(
      error
    )
    await expect(reservation.promise).rejects.toBe(error)
    expect(paneSpawnReservationsByOwnerKey.has('provenance-runtime-cleanup')).toBe(false)
    expect(cancel).toHaveBeenCalledExactlyOnceWith('pending', undefined)
    expect(release).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledOnce()
    expect(console.warn).toHaveBeenCalledWith(
      '[launch-ledger] runtime-controller: provenance unavailable'
    )
  })
})
