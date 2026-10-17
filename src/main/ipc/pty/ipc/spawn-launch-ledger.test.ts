import * as attribution from './spawn-launch-attribution'
import * as provenance from '../../../launch-ledger/spawn-launch-record'
import * as execution from './spawn-execute'
import { createHash } from 'node:crypto'
import { createAutomationOutputBindingRequest } from '../../../automations/automation-output-binding'
import { clearAutomationDispatchTokens } from '../../../automations/dispatch-tokens'
import type * as NodeFs from 'node:fs/promises'
import { appendFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtySpawnOptions } from '../../../providers/types'
import {
  noteLaunchTriggerHint,
  _resetLaunchTriggerHintsForTests,
  takeLaunchCauseHints
} from '../../../observability/launch-trigger-hints'
import type { PtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

const mocks = vi.hoisted(() => ({
  prepareInterruptedResume: vi.fn(),
  spawnOptions: [] as PtySpawnOptions[],
  count: 0,
  reattach: false,
  incarnationId: undefined as string | undefined,
  early: false,
  commitFail: false,
  inspectDispatch: vi.fn(),
  executionGate: null as Promise<void> | null,
  fail: false,
  preflight: vi.fn()
}))

vi.mock('./interrupted-resume', () => ({
  prepareInterruptedResume: mocks.prepareInterruptedResume
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof NodeFs>()
  return { ...fs, appendFile: vi.fn(fs.appendFile) }
})

vi.mock('./spawn-begin', () => ({
  beginPtyIpcSpawn: vi.fn(async () => (mocks.early ? { id: 'pty-99', isReattach: true } : null))
}))
vi.mock('./spawn-preflight', () => ({
  preparePtyIpcSpawnPreflight: vi.fn(async (ctx: PtyIpcSpawnState) => {
    mocks.preflight(ctx)
  })
}))
vi.mock('./spawn-env', () => ({
  assemblePtyIpcSpawnEnv: vi.fn(async (ctx: PtyIpcSpawnState) => {
    ctx.launchCommand = ctx.args.command
  })
}))
vi.mock('./spawn-execute', () => ({
  executePtyIpcSpawn: vi.fn(async (ctx: PtyIpcSpawnState) => {
    mocks.inspectDispatch()
    await mocks.executionGate
    if (mocks.fail) {
      throw new Error('provider refused')
    }
    ctx.result = {
      id: `pty-${mocks.count + 1}`,
      isReattach: mocks.reattach,
      ...(mocks.incarnationId ? { incarnationId: mocks.incarnationId } : {})
    }
  })
}))
vi.mock('./spawn-commit', () => ({
  commitPtyIpcSpawn: vi.fn(async (ctx: PtyIpcSpawnState) => {
    if (mocks.commitFail) {
      throw new Error('publication failed')
    }
    mocks.spawnOptions.push(ctx.spawnOptions)
    ctx.result = {
      id: `pty-${++mocks.count}`,
      isReattach: mocks.reattach,
      ...(mocks.incarnationId ? { incarnationId: mocks.incarnationId } : {})
    }
    resolvePaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, ctx.result)
    return ctx.result
  })
}))
vi.mock('../provider/registry', () => ({ localProvider: {} }))
vi.mock('../host-env/codex-home', () => ({
  CODEX_HOME_ENV_KEYS: ['CODEX_HOME', 'ORCA_CODEX_HOME']
}))
vi.mock('../host-env/codex-resume', () => ({
  noCodexResumeLaunch: (command: string | undefined) => ({
    codexResumeHome: null,
    command,
    notifyResumeUnavailable: false,
    droppedResumeArgv: false,
    providerSession: null
  })
}))
vi.mock('../../../runtime/new-agent-session-command-defaults', () => ({
  resolveNewAgentSessionCommandDefaults: vi.fn(async (input: { command?: string }) => input.command)
}))

import { runPtyIpcSpawn } from './spawn-run'
import {
  makePaneSpawnReservationKey,
  reservePaneSpawn,
  resolvePaneSpawnReservation,
  clearPaneSpawnReservation,
  paneSpawnReservationsByOwnerKey
} from '../pane/spawn-reservation'

import { drainLaunchLedgerAfterProducersStop } from '../../../launch-ledger/launch-ledger'
import { registerLaunchLedgerTestDirectory } from '../../../launch-ledger/launch-ledger-test-directory'
import { setLatencyTelemetryEnabledReader } from '../../../observability/latency-probe-switch'
const readRows = registerLaunchLedgerTestDirectory()
beforeEach(async () => {
  _resetLaunchTriggerHintsForTests()
  mocks.count = 0
  mocks.executionGate = null
  mocks.incarnationId = undefined
  mocks.reattach = false
  mocks.early = false
  mocks.fail = false
  mocks.commitFail = false
  mocks.inspectDispatch.mockReset()
  mocks.preflight.mockReset()
  mocks.prepareInterruptedResume.mockReturnValue(null)
})
afterEach(() => _resetLaunchTriggerHintsForTests())
async function spawn(extra: Record<string, unknown> = {}, store?: PtySpawnIpcDeps['store']) {
  return runPtyIpcSpawn(
    { store, getSettings: () => ({ restoreFloodGuard: false }) } as PtySpawnIpcDeps,
    {
      cols: 80,
      rows: 24,
      command: 'claude',
      launchAgent: 'claude',
      worktreeId: 'folder:99999999-9999-4999-8999-999999999999',
      tabId: '11111111-1111-4111-8111-111111111111',
      ...extra
    } as PtySpawnIpcArgs
  )
}
const expectedRow = {
  v: 1,
  launchId: expect.stringMatching(/^[0-9a-f-]{36}$/),
  ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  pipeline: 'renderer-ipc',
  ptyId: 'pty-1',
  worktreeId: 'folder:99999999-9999-4999-8999-999999999999',
  tabId: '11111111-1111-4111-8111-111111111111',
  agent: 'claude',
  cause: 'unknown',
  actor: { kind: 'renderer' },
  hasStartupCommand: true,
  process: 'created'
}
describe('renderer IPC durable launch provenance', async () => {
  it('records automation ownership only for this host-issued dispatch grant', async () => {
    const automationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const automationRunId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const store = {
      listAutomationRuns: () => [{ id: automationRunId, automationId, status: 'dispatching' }]
    } as never
    const grant = createAutomationOutputBindingRequest(
      store,
      {
        id: automationId,
        structuredOutput: true,
        executionTargetType: 'local',
        agentId: 'claude',
        workspaceMode: 'existing',
        workspaceId: expectedRow.worktreeId
      } as never,
      { id: automationRunId, automationId } as never
    )!
    await spawn(
      {
        launchTrigger: 'automation',
        launchReference: { automationId, automationRunId },
        automationOutputBinding: grant
      },
      store
    )
    expect(await readRows()).toEqual([
      {
        ...expectedRow,
        cause: 'automation',
        reference: { automationId, automationRunId },
        claimedTrigger: 'automation',
        claimedReferenceHashes: {
          automationId: `hash_${createHash('sha256').update(automationId).digest('hex').slice(0, 12)}`,
          automationRunId: `hash_${createHash('sha256').update(automationRunId).digest('hex').slice(0, 12)}`
        }
      }
    ])
  })
  it.each(['missing', 'forged', 'wrong-workspace', 'wrong-agent'])(
    'keeps an unrelated dispatching run a claim: %s',
    async (caseName) => {
      const automationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      const automationRunId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      const store = {
        listAutomationRuns: () => [{ id: automationRunId, automationId, status: 'dispatching' }]
      } as never
      const grant = createAutomationOutputBindingRequest(
        store,
        {
          id: automationId,
          structuredOutput: true,
          executionTargetType: 'local',
          agentId: caseName === 'wrong-agent' ? 'codex' : 'claude',
          workspaceMode: 'existing',
          workspaceId: caseName === 'wrong-workspace' ? 'other' : expectedRow.worktreeId
        } as never,
        { id: automationRunId, automationId } as never
      )!
      await spawn(
        {
          launchTrigger: 'automation',
          launchReference: { automationId, automationRunId },
          ...(caseName === 'missing'
            ? {}
            : {
                automationOutputBinding: {
                  ...grant,
                  ...(caseName === 'forged' ? { token: 'forged' } : {})
                }
              })
        },
        store
      )
      expect(await readRows()).toEqual([
        {
          ...expectedRow,
          cause: 'renderer-spawn',
          claimedTrigger: 'automation',
          claimedReferenceHashes: {
            automationId: `hash_${createHash('sha256').update(automationId).digest('hex').slice(0, 12)}`,
            automationRunId: `hash_${createHash('sha256').update(automationRunId).digest('hex').slice(0, 12)}`
          }
        }
      ])
    }
  )
  it.each(['cleared', 'dispatched', 'dispatch_failed', 'cancelled'])(
    'a finished output dispatch remains a claim: %s',
    async (ended) => {
      const automationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      const automationRunId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      let status = 'dispatching'
      const store = {
        listAutomationRuns: () => [{ id: automationRunId, automationId, status }]
      } as never
      const grant = createAutomationOutputBindingRequest(
        store,
        {
          id: automationId,
          structuredOutput: true,
          executionTargetType: 'local',
          agentId: 'claude',
          workspaceMode: 'existing',
          workspaceId: expectedRow.worktreeId
        } as never,
        { id: automationRunId, automationId } as never
      )!
      if (ended === 'cleared') {
        clearAutomationDispatchTokens(automationId, automationRunId)
      } else {
        status = ended
      }
      await spawn(
        {
          launchTrigger: 'automation',
          launchReference: { automationId, automationRunId },
          automationOutputBinding: grant
        },
        store
      )
      expect(await readRows()).toEqual([
        {
          ...expectedRow,
          cause: 'renderer-spawn',
          claimedTrigger: 'automation',
          claimedReferenceHashes: {
            automationId: `hash_${createHash('sha256').update(automationId).digest('hex').slice(0, 12)}`,
            automationRunId: `hash_${createHash('sha256').update(automationRunId).digest('hex').slice(0, 12)}`
          }
        }
      ])
    }
  )
  it('retains the main cause through failed preparation until a retry records creation', async () => {
    const launchCause = {
      trigger: 'cli' as const,
      actor: { kind: 'paired-device' as const, deviceId: expectedRow.tabId },
      requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    }
    noteLaunchTriggerHint({
      worktreeId: expectedRow.worktreeId,
      tabId: expectedRow.tabId,
      trigger: 'cli',
      launchCause
    })
    mocks.preflight.mockImplementationOnce(() => {
      throw new Error('preparation failed')
    })
    await expect(spawn()).rejects.toThrow('preparation failed')
    await spawn()
    expect(await readRows()).toEqual([
      {
        ...expectedRow,
        ptyId: null,
        cause: 'cli',
        actor: launchCause.actor,
        requestId: launchCause.requestId,
        process: 'failed'
      },
      { ...expectedRow, cause: 'cli', actor: launchCause.actor, requestId: launchCause.requestId }
    ])
    expect(
      takeLaunchCauseHints({ worktreeId: expectedRow.worktreeId, tabId: expectedRow.tabId })
        .tabCause
    ).toBeNull()
  })
  it('writes N rows for N calls and records reattach', async () => {
    await spawn()
    await spawn()
    mocks.reattach = true
    await spawn()
    expect(await readRows()).toEqual([
      { ...expectedRow },
      { ...expectedRow, ptyId: 'pty-2' },
      { ...expectedRow, ptyId: 'pty-3', process: 'attached' }
    ])
  })
  it('keeps daemon incarnation on both created and attached receipts', async () => {
    mocks.incarnationId = '33333333-3333-4333-8333-333333333333'
    await spawn()
    mocks.reattach = true
    await spawn()
    expect(await readRows()).toEqual([
      { ...expectedRow, incarnationId: mocks.incarnationId },
      { ...expectedRow, ptyId: 'pty-2', process: 'attached', incarnationId: mocks.incarnationId }
    ])
  })
  it('records plain shells', async () => {
    await spawn({ command: undefined, launchAgent: undefined })
    expect((await readRows()).map((row) => row.hasStartupCommand)).toEqual([false])
  })
  it('rejects renderer actor impersonation and free text reference keys', async () => {
    await spawn({
      launchTrigger: 'automation',
      actor: { kind: 'paired-device', deviceId: 'forged' },
      launchReference: { automationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', freeText: 'secret' }
    })
    expect((await readRows()).map(({ actor, reference }) => ({ actor, reference }))).toEqual([
      {
        actor: { kind: 'renderer' },
        reference: undefined
      }
    ])
  })
  it('uses the full main tab hint over the renderer label', async () => {
    const cause = {
      trigger: 'cli',
      actor: { kind: 'local-cli' },
      requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      reference: { agentSessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
    }
    noteLaunchTriggerHint({
      worktreeId: 'folder:99999999-9999-4999-8999-999999999999',
      tabId: '11111111-1111-4111-8111-111111111111',
      trigger: 'cli',
      launchCause: cause
    } as never)
    await spawn({ launchTrigger: 'person-reveal' })
    expect(
      (await readRows()).map(({ cause, actor, requestId, reference }) => ({
        cause,
        actor,
        requestId,
        reference
      }))
    ).toEqual([
      {
        cause: 'cli',
        actor: { kind: 'local-cli' },
        requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        reference: { agentSessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
      }
    ])
  })
  it('captures the requesting actor before slow preflight can expire its hint', async () => {
    const clock = Date.now
    const now = clock()
    noteLaunchTriggerHint(
      {
        worktreeId: 'folder:99999999-9999-4999-8999-999999999999',
        tabId: '11111111-1111-4111-8111-111111111111',
        trigger: 'cli',
        launchCause: {
          trigger: 'cli',
          actor: { kind: 'local-cli' },
          requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
        }
      },
      now
    )
    mocks.preflight.mockImplementation(() => {
      vi.spyOn(Date, 'now').mockImplementation(() => clock() + 31_000)
    })
    await spawn({ launchTrigger: 'new' })
    expect(await readRows()).toEqual([
      {
        ...expectedRow,
        cause: 'cli',
        claimedTrigger: 'new',
        actor: { kind: 'local-cli' },
        requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      }
    ])
  })
  it('records unknown and warns once with renderer-ipc', async () => {
    await spawn()
    expect((await readRows()).map((row) => row.cause)).toEqual(['unknown'])
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[launch-ledger\].*renderer-ipc/)
    )
  })
  it('retains known pane identity on an early attachment', async () => {
    mocks.early = true
    const leafId = '22222222-2222-4222-8222-222222222222'
    await spawn({ launchTrigger: 'new', leafId })
    expect(await readRows()).toEqual([
      {
        ...expectedRow,
        ptyId: 'pty-99',
        paneKey: `11111111-1111-4111-8111-111111111111:${leafId}`,
        cause: 'renderer-spawn',
        claimedTrigger: 'new',
        process: 'attached',
        intent: 'attach'
      }
    ])
  })
  it('records an early reservation attachment exactly once', async () => {
    const leafId = '22222222-2222-4222-8222-222222222222'
    const paneKey = `11111111-1111-4111-8111-111111111111:${leafId}`
    const ownerKey = makePaneSpawnReservationKey(
      'folder:99999999-9999-4999-8999-999999999999',
      undefined,
      paneKey
    )!
    const reservation = reservePaneSpawn(ownerKey)
    mocks.preflight.mockImplementation((ctx: PtyIpcSpawnState) => {
      ctx.reservationPaneKey = paneKey
    })
    try {
      const pending = spawn({ launchTrigger: 'new', leafId })
      reservation.resolve({ id: 'pty-100' })
      await pending
      expect(mocks.count).toBe(0)
      expect((await readRows()).filter((row) => row.process === 'attached')).toEqual([
        {
          ...expectedRow,
          ptyId: 'pty-100',
          paneKey,
          cause: 'renderer-spawn',
          claimedTrigger: 'new',
          process: 'attached',
          intent: 'attach'
        }
      ])
    } finally {
      clearPaneSpawnReservation(ownerKey, reservation)
    }
  })
  it('two simultaneous callers share the real pane reservation and keep separate launch receipts', async () => {
    const leafId = '22222222-2222-4222-8222-222222222222'
    const paneKey = `11111111-1111-4111-8111-111111111111:${leafId}`
    mocks.preflight.mockImplementation((ctx: PtyIpcSpawnState) => {
      ctx.reservationPaneKey = paneKey
    })
    const replies = await Promise.all([
      spawn({ leafId, launchTrigger: 'new' }),
      spawn({ leafId, launchTrigger: 'new' })
    ])
    expect(replies.map((reply) => ('id' in reply ? reply.id : undefined))).toEqual([
      'pty-1',
      'pty-1'
    ])
    expect(mocks.inspectDispatch).toHaveBeenCalledOnce()
    expect(await readRows()).toEqual([
      {
        ...expectedRow,
        cause: 'renderer-spawn',
        claimedTrigger: 'new',
        paneKey,
        ptyId: 'pty-1',
        process: 'created'
      },
      {
        ...expectedRow,
        cause: 'renderer-spawn',
        claimedTrigger: 'new',
        paneKey,
        ptyId: 'pty-1',
        process: 'attached',
        intent: 'attach'
      }
    ])
    expect(await readRows(true)).toHaveLength(4)
    expect(new Set((await readRows(true)).map((row) => row.launchId)).size).toBe(2)
  })
  it('queues preparation before its outcome without waiting for disk', async () => {
    await spawn()
    expect((await readRows(true)).map((row) => row.process)).toEqual(['prepared', 'created'])
  })
  it('records a physical start despite publication failure', async () => {
    mocks.commitFail = true
    await expect(spawn()).rejects.toThrow('publication failed')
    expect((await readRows()).at(-1)).toMatchObject({ ptyId: 'pty-1', process: 'created' })
  })
  it('records uncertainty when the provider throws without a receipt', async () => {
    mocks.fail = true
    await expect(spawn()).rejects.toThrow('provider refused')
    expect(await readRows()).toEqual([expect.objectContaining({ process: 'unknown', ptyId: null })])
  })
  it('retains an agent hint across a shell and consumes a shell-specific hint', async () => {
    const cause = {
      trigger: 'cli',
      actor: { kind: 'local-cli' },
      requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef'
    }
    noteLaunchTriggerHint({
      worktreeId: 'folder:99999999-9999-4999-8999-999999999999',
      tabId: '11111111-1111-4111-8111-111111111111',
      trigger: 'cli',
      launchCause: cause,
      hasStartupCommand: false
    } as never)
    await spawn({ command: undefined, launchAgent: undefined, launchTrigger: 'new' })
    expect(await readRows()).toEqual([
      {
        v: 1,
        launchId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        ts: expectedRow.ts,
        pipeline: 'renderer-ipc',
        ptyId: 'pty-1',
        worktreeId: 'folder:99999999-9999-4999-8999-999999999999',
        tabId: '11111111-1111-4111-8111-111111111111',
        cause: 'cli',
        claimedTrigger: 'new',
        actor: { kind: 'local-cli' },
        requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef',
        hasStartupCommand: false,
        process: 'created'
      }
    ])
    noteLaunchTriggerHint({
      worktreeId: 'folder:99999999-9999-4999-8999-999999999999',
      tabId: '11111111-1111-4111-8111-111111111111',
      trigger: 'cli',
      launchCause: cause
    } as never)
    await spawn({ command: undefined, launchAgent: undefined, launchTrigger: 'new' })
    await spawn({ launchTrigger: 'new' })
    expect((await readRows()).at(-1)).toEqual({
      ...expectedRow,
      ptyId: 'pty-3',
      cause: 'cli',
      claimedTrigger: 'new',
      actor: { kind: 'local-cli' },
      requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef'
    })
  })
  it('writes with latency telemetry switched off', async () => {
    setLatencyTelemetryEnabledReader(() => false)
    await spawn()
    expect((await readRows()).map((row) => row.ptyId)).toEqual(['pty-1'])
  })
})

describe('disk-independent IPC admission', () => {
  it('a blocked or failed disk append neither delays nor fails a spawn', async () => {
    let release = () => {}
    let started = () => {}
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(appendFile).mockImplementationOnce(async () => {
      started()
      await gate
      throw new Error('private disk failure')
    })
    try {
      const pending = spawn({ launchTrigger: 'new' })
      await began
      expect(await pending).toMatchObject({ id: 'pty-1' })
    } finally {
      release()
    }
    const rows = await readRows(true)
    expect(rows).toEqual([{ ...expectedRow, cause: 'renderer-spawn', claimedTrigger: 'new' }])
  })
})

describe('quit after IPC launch admission', () => {
  it('waits for the active pipeline and retains its receipt before quitting', async () => {
    let release!: () => void
    mocks.executionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const spawning = spawn({ launchTrigger: 'new' })
    let quitFinished = false
    const quitting = drainLaunchLedgerAfterProducersStop([]).then(() => {
      quitFinished = true
    })
    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(quitFinished).toBe(false)
      release()
      await spawning
      await quitting
      expect(await readRows()).toEqual([
        { ...expectedRow, cause: 'renderer-spawn', claimedTrigger: 'new' }
      ])
    } finally {
      release()
      await spawning
      await quitting
    }
  })
})

describe('IPC provenance cannot change execution', () => {
  it.each(['prepareIpcSpawnLaunch', 'recordIpcSpawnLaunch'] as const)(
    'a throwing %s does not change the successful spawn result',
    async (name) => {
      const baseline = await spawn()
      mocks.count = 0
      vi.spyOn(provenance, name).mockImplementation(() => {
        throw new Error('private recorder failure')
      })
      await expect(spawn()).resolves.toEqual(baseline)
    }
  )

  it('returns the same successful spawn when cause resolution throws', async () => {
    const baseline = await spawn()
    mocks.count = 0
    vi.spyOn(attribution, 'resolveIpcSpawnLaunchCause').mockImplementation(() => {
      throw new Error('private provenance failure')
    })
    await expect(spawn()).resolves.toEqual(baseline)
    expect((await readRows()).at(-1)).toMatchObject({ ptyId: 'pty-1', cause: 'unknown' })
    expect(console.warn).toHaveBeenCalledWith(
      '[launch-ledger] renderer-ipc: provenance unavailable'
    )
  })

  it('preserves the original error and all cleanup when the failure recorder throws', async () => {
    const error = new Error('provider original error')
    const dispose = vi.fn()
    const releaseLeader = vi.fn()
    const cancel = vi.fn()
    const release = vi.fn()
    const finish = vi.fn()
    const hidden = vi.fn()
    const reservation = reservePaneSpawn('provenance-ipc-cleanup')
    mocks.prepareInterruptedResume.mockReturnValue({ dispose, commit: vi.fn() })
    vi.spyOn(execution, 'executePtyIpcSpawn').mockImplementationOnce(async (ctx) => {
      ctx.paneSpawnReservationKey = 'provenance-ipc-cleanup'
      ctx.paneSpawnReservation = reservation
      ctx.preSpawnHiddenMarkId = 'hidden'
      ctx.agentTeamsLeaderHandle = 'leader'
      ctx.pendingRegistrationPtyId = 'pending'
      ctx.releaseWorktreeSpawn = release
      ctx.finishTerminalInstall = finish
      throw error
    })
    vi.spyOn(provenance, 'recordSpawnLaunchFailure').mockImplementation(() => {
      throw new Error('private recorder failure')
    })
    await expect(
      runPtyIpcSpawn(
        {
          runtime: {
            releaseClaudeAgentTeamsLeaderForHandle: releaseLeader,
            cancelPendingPtyRegistration: cancel
          },
          transitionSpawnHiddenRendererPtyDeliveryState: hidden,
          getSettings: () => ({ restoreFloodGuard: false })
        } as never,
        { cols: 80, rows: 24, command: 'claude' }
      )
    ).rejects.toBe(error)
    await expect(reservation.promise).rejects.toBe(error)
    expect(paneSpawnReservationsByOwnerKey.has('provenance-ipc-cleanup')).toBe(false)
    expect(hidden).toHaveBeenCalledExactlyOnceWith('hidden', false)
    expect(dispose).toHaveBeenCalledOnce()
    expect(releaseLeader).toHaveBeenCalledExactlyOnceWith('leader')
    expect(cancel).toHaveBeenCalledExactlyOnceWith('pending', undefined)
    expect(release).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledOnce()
    expect(console.warn).toHaveBeenCalledWith(
      '[launch-ledger] renderer-ipc: provenance unavailable'
    )
  })
})
