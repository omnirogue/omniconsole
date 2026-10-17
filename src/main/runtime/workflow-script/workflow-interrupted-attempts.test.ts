import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { createWorkflowLocalProcessLaunch } from './workflow-local-process-launch'
import { claimWorkflowOwner, captureWorkflowOwner } from './workflow-owner-claim'
import { workflowCallDigest } from './workflow-call-digest'
import type { WorkflowProgramCall } from './workflow-program-context'
import {
  WORKFLOW_INTERRUPTED_BEFORE_START,
  WORKFLOW_INTERRUPTED_ERROR
} from './workflow-checkpoint-process'
import {
  probeInterruptedWorkflowProcess,
  settleInterruptedWorkflowAttempts,
  type WorkflowInterruptedProcessProbe
} from './workflow-interrupted-attempts'
import { readLocalWorkflowCallLog } from './local-workflow-call-log'
import { projectLocalWorkflowCalls } from './local-workflow-call-projection'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { WorkflowScriptSlots } from './workflow-script-slots'
import { reconcileWorkflowProgram } from './workflow-program-recovery'
import { runCouncilProgram } from './presets/council'
import { createWorkflowProgramContext } from './workflow-program-context'
import type { WorkflowProgramSnapshot } from './workflow-execution-service'

const directories: string[] = []
const helpers: ChildProcess[] = []
const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const helper of helpers.splice(0)) {
    helper.kill('SIGKILL')
  }
  databases.splice(0).forEach((database) => database.close())
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const HOST = 'fixture-host'
const PREVIOUS_OWNER = { hostId: HOST, pid: 987654, processStartTimeMs: 1, spawnToken: 'previous' }
const seats = ['claude', 'codex', 'grok'].map((agent, index) => ({
  id: agent,
  agent: agent as 'claude' | 'codex' | 'grok',
  accountId: `account-${index}`,
  model: `${agent}-model`,
  effort: null,
  lineage: (['anthropic', 'openai', 'xai'] as const)[index],
  policyRevision: 'fixture'
}))
const snapshot: WorkflowProgramSnapshot = {
  version: 1,
  task: { prompt: 'Question', evidence: 'Frozen evidence' },
  seats,
  synthesizerId: 'claude',
  councilProgramRevision: 4
}

/** The exact call the Council program asks first, so a replay recognizes its record. */
async function firstAnswerCall(): Promise<WorkflowProgramCall> {
  const calls: WorkflowProgramCall[] = []
  const context = createWorkflowProgramContext({
    agent: async (call) => {
      calls.push(call)
      throw new Error('collected')
    },
    guard: () => {},
    phase: () => {},
    log: () => {},
    isFatal: () => false
  })
  await runCouncilProgram(
    context,
    { panel: seats, synthesizerId: 'claude', revision: 4 },
    snapshot.task
  ).catch(() => {})
  const call = calls.find((entry) => entry.id === 'answers/claude')
  if (!call) {
    throw new Error('Council asked no answers/claude call')
  }
  return call
}

/**
 * A run whose owner launched `answers/claude` and then died: the agent ran to completion but
 * the owner never wrote terminal.json. The run is then claimed by this process at fence 2.
 */
async function interruptedRun(
  options: { launch?: boolean; prepareOnly?: boolean; remote?: boolean } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-interrupted-'))
  directories.push(directory)
  const database = new OrchestrationDb(join(directory, 'workflow.db'))
  databases.push(database)
  const db = database.db
  const store = new WorkflowCheckpointStore(db)
  const call = await firstAnswerCall()
  const seat = seats[0]
  const executionId = store.create({
    conversationId: 'c',
    requestId: 'r',
    snapshot: {
      ...snapshot,
      host: {
        startedAt: 1,
        ...(options.remote
          ? {
              placement: {
                runsOn: 'fleet',
                mode: 'dispatched-seats',
                host: { name: 'worker', machine: 'worker', ssh: 'worker' },
                dispatch: { root: '/remote/run' }
              }
            }
          : {})
      }
    } as WorkflowProgramSnapshot,
    owner: PREVIOUS_OWNER,
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 5
  })
  const inputDigest = workflowCallDigest(call, JSON.stringify(seat), seat.agent)
  const prepared = store.prepare({
    executionId,
    fence: 1,
    callId: call.id,
    inputDigest,
    reservation: 1,
    validate: () => {}
  })
  if (!('attemptId' in prepared)) {
    throw new Error('Expected attempt')
  }
  const ledger = join(directory, 'ledger')
  const launch = createWorkflowLocalProcessLaunch({
    directory,
    executionId,
    fence: 1,
    hostId: HOST,
    ownerIncarnation: PREVIOUS_OWNER.spawnToken,
    timeoutMs: 5000,
    maxOutputBytes: 4096,
    ...(options.remote
      ? {
          launchEvidence: {
            dispatch: {
              host: 'worker',
              machine: 'worker',
              directory: `/remote/run/attempts/${prepared.attemptId}`
            }
          }
        }
      : {}),
    command: () => ({
      program: process.execPath,
      args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(ledger)}, 'spawn\\n')`],
      input: call.prompt
    })
  })
  if (options.launch !== false) {
    await launch({
      ...prepared,
      call,
      problems: null,
      signal: new AbortController().signal,
      recordPreparation: (identity) =>
        store.recordProcessPreparation(prepared.attemptId, 1, identity),
      recordLaunch: (ref) => store.recordLaunch(prepared.attemptId, 1, ref),
      recordNoLaunch: (reason) => store.recordNoLaunch(prepared.attemptId, 1, reason)
    })
    // The owner died after its agent exited and before it recorded the exit.
    rmSync(join(directory, prepared.attemptId, 'terminal.json'))
  }
  const transaction = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = work()
      db.exec('COMMIT')
      return value
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const claim = () =>
    captureWorkflowOwner(HOST).then((owner) =>
      claimWorkflowOwner({
        db,
        transaction,
        executionId,
        expectedFence: 1,
        owner,
        probe: async () => ({ outcome: 'pid-absent' })
      })
    )
  if (!options.prepareOnly) {
    expect(await claim()).toBe(2)
  }
  const attemptId = prepared.attemptId
  const attempt = () =>
    db
      .prepare('SELECT state,receipt_json FROM local_workflow_attempts WHERE id=?')
      .get(attemptId) as {
      state: string
      receipt_json: string | null
    }
  const launchPath = join(directory, attemptId, 'launch.json')
  /** Points the launch receipt at another process, as if that process were the agent. */
  const recordAgent = (pid: number, launchedAt: number) => {
    const receipt = JSON.parse(readFileSync(launchPath, 'utf8'))
    writeFileSync(
      launchPath,
      JSON.stringify({
        ...receipt,
        pid,
        processGroupId: pid,
        launchedAt: new Date(launchedAt).toISOString()
      })
    )
  }
  const settle = (probe?: WorkflowInterruptedProcessProbe) =>
    settleInterruptedWorkflowAttempts({ store, executionId, fence: 2, probe })
  return {
    db,
    store,
    call,
    executionId,
    directory,
    attemptId,
    attempt,
    inputDigest,
    ledger,
    launchPath,
    recordAgent,
    settle,
    claim,
    state: () => store.inspect(executionId, 2).state
  }
}

/** A process in its own group, standing in for an agent that outlived its owner. */
function detachedHelper(): Promise<ChildProcess & { pid: number }> {
  const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    detached: true,
    stdio: 'ignore'
  })
  helpers.push(helper)
  return new Promise((resolve, reject) => {
    helper.once('spawn', () => resolve(helper as ChildProcess & { pid: number }))
    helper.once('error', reject)
  })
}

function exitOf(helper: ChildProcess): Promise<NodeJS.Signals | number | null> {
  return new Promise((resolve) => {
    if (helper.exitCode !== null || helper.signalCode !== null) {
      resolve(helper.signalCode ?? helper.exitCode)
      return
    }
    helper.once('exit', (code, signal) => resolve(signal ?? code))
  })
}

const probeWith = (overrides: Partial<WorkflowInterruptedProcessProbe>) => ({
  isPidPresent: () => true,
  isGroupPresent: () => true,
  readStartTimeMs: async () => 1_000_000,
  terminateGroup: async () => {
    throw new Error('must not signal')
  },
  ...overrides
})

describe('probeInterruptedWorkflowProcess', () => {
  const launch = { pid: 4242, launchedAt: 1_000_000 }

  it('reports an exited agent gone, flagging but never signalling leftover group members', async () => {
    expect(
      await probeInterruptedWorkflowProcess(
        launch,
        probeWith({ isPidPresent: () => false, isGroupPresent: () => false })
      )
    ).toEqual({ kind: 'gone', groupCleanupRequired: false })
    expect(
      await probeInterruptedWorkflowProcess(launch, probeWith({ isPidPresent: () => false }))
    ).toEqual({ kind: 'gone', groupCleanupRequired: true })
  })

  it('treats a pid that started after the launch as reused, never as the agent', async () => {
    expect(
      await probeInterruptedWorkflowProcess(
        launch,
        probeWith({ readStartTimeMs: async () => launch.launchedAt + 60_000 })
      )
    ).toEqual({ kind: 'gone', groupCleanupRequired: false })
  })

  it('identifies the agent by a start time at its launch, to the second', async () => {
    for (const started of [launch.launchedAt - 999, launch.launchedAt, launch.launchedAt + 1500]) {
      expect(
        await probeInterruptedWorkflowProcess(
          launch,
          probeWith({ readStartTimeMs: async () => started })
        )
      ).toEqual({ kind: 'orphan' })
    }
  })

  it('stays unknown when the process cannot be identified', async () => {
    for (const readStartTimeMs of [
      async () => null,
      async () => {
        throw new Error('ps failed')
      },
      async () => launch.launchedAt - 10 * 60_000
    ]) {
      expect(
        await probeInterruptedWorkflowProcess(launch, probeWith({ readStartTimeMs }))
      ).toMatchObject({ kind: 'unknown' })
    }
  })
})

describe.skipIf(process.platform === 'win32')('interrupted workflow attempts', () => {
  it('settles an agent that exited with its owner, and Resume asks the call again', async () => {
    const f = await interruptedRun()
    expect(f.attempt().state).toBe('running')
    expect(f.state()).toBe('pausing')

    expect(await f.settle()).toEqual({ settled: ['answers/claude'], unresolved: new Map() })
    const settled = f.attempt()
    expect(settled.state).toBe('failed')
    expect(JSON.parse(settled.receipt_json!)).toMatchObject({
      attemptId: f.attemptId,
      processReceiptRef: f.launchPath,
      liveness: 'exited',
      interrupted: true,
      groupCleanupRequired: false,
      error: WORKFLOW_INTERRUPTED_ERROR,
      recoveredByFence: 2,
      preparedProcess: expect.any(Object)
    })
    expect(f.state()).toBe('paused')
    // Settling launched nothing.
    expect(readFileSync(f.ledger, 'utf8')).toBe('spawn\n')

    f.store.resume(f.executionId, 2)
    expect(
      f.store.prepare({
        executionId: f.executionId,
        fence: 2,
        callId: f.call.id,
        inputDigest: f.inputDigest,
        reservation: 1,
        validate: () => {}
      })
    ).toMatchObject({ ordinal: 2 })
    // The new owner's own attempt is never another owner's leftover.
    expect(await f.settle()).toEqual({ settled: [], unresolved: new Map() })
  })

  it('stops an agent still running from before the restart, then settles it', async () => {
    const f = await interruptedRun()
    const agent = await detachedHelper()
    f.recordAgent(agent.pid, Date.now())

    expect(await f.settle()).toEqual({ settled: ['answers/claude'], unresolved: new Map() })
    expect(await exitOf(agent)).toBe('SIGKILL')
    expect(JSON.parse(f.attempt().receipt_json!)).toMatchObject({
      interrupted: true,
      stoppedByFence: 2
    })
    expect(f.state()).toBe('paused')
  })

  it('never signals a process that reused the agent pid', async () => {
    const f = await interruptedRun()
    const stranger = await detachedHelper()
    f.recordAgent(stranger.pid, Date.now() - 10 * 60_000)

    expect(await f.settle()).toEqual({ settled: ['answers/claude'], unresolved: new Map() })
    expect(stranger.exitCode).toBeNull()
    expect(stranger.signalCode).toBeNull()
    expect(() => process.kill(stranger.pid, 0)).not.toThrow()
    expect(JSON.parse(f.attempt().receipt_json!)).not.toHaveProperty('stoppedByFence')
  })

  it('holds an agent it cannot identify, with a reason instead of a file error', async () => {
    const f = await interruptedRun()
    const outcome = await f.settle(
      probeWith({ readStartTimeMs: async () => null }) as WorkflowInterruptedProcessProbe
    )
    expect(outcome.settled).toEqual([])
    expect(outcome.unresolved.get(f.attemptId)).toMatch(/could not be identified/)
    expect(f.attempt().state).toBe('running')
    expect(f.state()).toBe('pausing')
  })

  it('holds a launched attempt whose launch record is gone', async () => {
    const f = await interruptedRun()
    rmSync(f.launchPath)
    const outcome = await f.settle()
    expect(outcome.unresolved.get(f.attemptId)).toMatch(/cannot tell whether this agent started/)
    expect(f.attempt().state).toBe('running')
  })

  it('holds a live agent it could not stop', async () => {
    const f = await interruptedRun()
    const outcome = await f.settle(
      probeWith({
        readStartTimeMs: async () => Date.now(),
        terminateGroup: async () => false
      }) as WorkflowInterruptedProcessProbe
    )
    expect(outcome.unresolved.get(f.attemptId)).toMatch(/still running .* could not be stopped/)
    expect(f.attempt().state).toBe('running')
  })

  it('settles a reserved attempt that never started, and one that stopped before its directory', async () => {
    const unprepared = await interruptedRun({ launch: false })
    expect(await unprepared.settle()).toEqual({
      settled: ['answers/claude'],
      unresolved: new Map()
    })
    expect(unprepared.attempt().state).toBe('failed')
    expect(JSON.parse(unprepared.attempt().receipt_json!)).toMatchObject({
      noLaunch: true,
      interrupted: true,
      reason: WORKFLOW_INTERRUPTED_BEFORE_START
    })

    const preparedOnly = await interruptedRun({ launch: false, prepareOnly: true })
    preparedOnly.store.recordProcessPreparation(preparedOnly.attemptId, 1, {
      directory: preparedOnly.directory,
      executionId: preparedOnly.executionId,
      hostId: HOST,
      ownerIncarnation: 'previous',
      fence: 1,
      attemptId: preparedOnly.attemptId,
      callId: 'answers/claude',
      ordinal: 1,
      commandDigest: 'a'.repeat(64),
      inputDigest: 'b'.repeat(64),
      maxOutputBytes: 4096
    })
    expect(await preparedOnly.claim()).toBe(2)
    expect(await preparedOnly.settle()).toMatchObject({ settled: ['answers/claude'] })

    // With its directory made, the spawn may have happened: that stays unresolved.
    const started = await interruptedRun({ launch: false, prepareOnly: true })
    started.store.recordProcessPreparation(started.attemptId, 1, {
      directory: started.directory,
      executionId: started.executionId,
      hostId: HOST,
      ownerIncarnation: 'previous',
      fence: 1,
      attemptId: started.attemptId,
      callId: 'answers/claude',
      ordinal: 1,
      commandDigest: 'a'.repeat(64),
      inputDigest: 'b'.repeat(64),
      maxOutputBytes: 4096
    })
    mkdirSync(join(started.directory, started.attemptId))
    expect(await started.claim()).toBe(2)
    const outcome = await started.settle()
    expect(outcome.settled).toEqual([])
    expect(outcome.unresolved.get(started.attemptId)).toMatch(/cannot tell whether/)
  })

  it('honors a stop requested before recovery', async () => {
    const f = await interruptedRun()
    f.store.requestControl(f.executionId, 2, 'stop')
    expect(await f.settle()).toMatchObject({ settled: ['answers/claude'] })
    expect(f.attempt().state).toBe('cancelled')
    expect(f.store.inspect(f.executionId, 2).state).toBe('cancelled')
  })

  it('refuses to settle when the attempt changed after it was probed', async () => {
    const f = await interruptedRun()
    const [orphan] = f.store.attempts.orphanedAttempts(f.executionId, 2)
    expect(() =>
      f.store.attempts.settleInterrupted(
        f.attemptId,
        2,
        { ...orphan, receipt_json: '{}' },
        { launched: true, groupCleanupRequired: false, stopped: false }
      )
    ).toThrow('evidence changed')
    expect(f.attempt().state).toBe('running')
  })

  it('shows the interruption on the call and reads its log without a file error', async () => {
    const f = await interruptedRun()
    await f.settle()
    expect(readLocalWorkflowCallLog(f.db, f.store, f.executionId, f.call.id)).toEqual({
      stdout: '',
      stderr: '',
      outputTruncated: false
    })
    const records = f.db.prepare('SELECT * FROM local_workflow_calls').all() as never[]
    const attempts = f.db
      .prepare('SELECT * FROM local_workflow_attempts ORDER BY ordinal')
      .all() as never[]
    const { calls } = projectLocalWorkflowCalls({
      snapshot: { ...snapshot, host: { startedAt: 1 } } as unknown as LocalWorkflowHostSnapshot,
      store: f.store,
      fence: 2,
      attemptLimit: 3,
      records,
      attempts,
      results: new Map(),
      receipts: new Map()
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ id: 'answers/claude', state: 'failed' })
    expect(calls[0].error).toBe(WORKFLOW_INTERRUPTED_ERROR)
    expect(calls[0].startedAt).toEqual(expect.any(Number))
  })

  it('reconciles the interrupted run to Paused with a note, not a file error', async () => {
    const f = await interruptedRun()
    const outcome = await reconcileWorkflowProgram({
      store: f.store,
      slots: new WorkflowScriptSlots(2),
      executionId: f.executionId,
      fence: 2,
      attestNativeResult: () => {}
    })
    expect(outcome).toEqual({
      state: 'paused',
      error: '1 agent was interrupted when OmniConsole closed. Resume runs it again.'
    })
    expect(f.attempt().state).toBe('failed')
  })

  it('reports why an unresolved agent still needs the person', async () => {
    const f = await interruptedRun()
    rmSync(f.launchPath)
    const outcome = await reconcileWorkflowProgram({
      store: f.store,
      slots: new WorkflowScriptSlots(2),
      executionId: f.executionId,
      fence: 2,
      attestNativeResult: () => {}
    })
    expect(outcome.state).toBe('recovery_required')
    expect(outcome.error).toMatch(/^answers\/claude: OmniConsole cannot tell whether/)
    expect(outcome.error).not.toMatch(/ENOENT/)
  })
})

describe.skipIf(process.platform === 'win32')('interrupted remote seats', () => {
  it('keeps Resume blocked until the recorded remote seat is confirmed exited', async () => {
    const f = await interruptedRun({ remote: true })
    const remote = vi.fn(async () => 'unverifiable' as const)
    const blocked = await settleInterruptedWorkflowAttempts({
      store: f.store,
      executionId: f.executionId,
      fence: 2,
      remote
    })
    expect(blocked.settled).toEqual([])
    expect([...blocked.unresolved.values()][0]).toContain('exit must be confirmed before Resume')
    expect(f.attempt().state).toBe('running')
    const stopped = vi.fn(async () => 'exited' as const)
    const settled = await settleInterruptedWorkflowAttempts({
      store: f.store,
      executionId: f.executionId,
      fence: 2,
      remote: stopped
    })
    expect(settled.settled).toEqual([f.call.id])
    expect(stopped).toHaveBeenCalledWith('worker', `/remote/run/attempts/${f.attemptId}`, true)
  })
})
