import { existsSync, readFileSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAppEnvironment } from '../../../shared/app-environment'
import type { WorkflowPlacement } from '../../../shared/local-workflow-placement'
import { OrchestrationDb } from '../orchestration/db'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { attestNativeResult } from './local-workflow-provider-launch'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import {
  createDurableWorkflowAgent,
  WorkflowHostLostError,
  type WorkflowAttemptLaunch
} from './workflow-durable-call'
import { WorkflowExecutionService } from './workflow-execution-service'
import { readyWorkflowFleetDispatch } from './workflow-fleet-dispatch'
import { launchWorkflowFleetSeats } from './workflow-fleet-seat-launch'
import { createFakeFleet, fakeCodexLogin, type FakeFleet } from './workflow-fleet.test-fixtures'
import { WORKFLOW_CALL_STALL_MS } from './workflow-call-timeout'
import type { WorkflowProgramCall } from './workflow-program-context'
import { WorkflowScriptSlots } from './workflow-script-slots'

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60_000
const PLACEMENT: WorkflowPlacement = {
  runsOn: 'fleet',
  mode: 'dispatched-seats',
  host: {
    name: 'mw0004',
    machine: 'mw0004',
    cores: 10,
    loadPerCore: 0.1,
    readAt: NOW,
    ssh: 'mw0004'
  }
}
const SEATS = [
  {
    id: 'a',
    agent: 'claude' as const,
    accountId: 'claude-account',
    model: 'claude-opus-5',
    effort: 'low',
    lineage: 'anthropic' as const,
    policyRevision: 'fixture-v1'
  },
  {
    id: 'b',
    agent: 'codex' as const,
    accountId: 'codex-account',
    model: 'gpt-5.6-sol',
    effort: 'low',
    lineage: 'openai' as const,
    policyRevision: 'fixture-v1'
  },
  {
    id: 'g',
    agent: 'grok' as const,
    accountId: 'grok-account',
    model: 'grok-4.6-build',
    effort: null,
    lineage: 'xai' as const,
    policyRevision: 'fixture-v1'
  }
]
const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false
}

function call(id: string, seatId: string): WorkflowProgramCall {
  return {
    id,
    seatId,
    prompt: `Frozen question for ${id}`,
    dependencies: [],
    schema: SCHEMA,
    validateSemantics: () => null
  }
}

let fleet: FakeFleet
let database: OrchestrationDb
const savedKey = process.env.ANTHROPIC_API_KEY
beforeEach(async () => {
  fleet = await createFakeFleet(['mw0004'])
  database = new OrchestrationDb(':memory:')
  // A key in this process must never reach a seat on the host.
  process.env.ANTHROPIC_API_KEY = 'not-a-real-key-on-this-computer'
})
afterEach(async () => {
  vi.useRealTimers()
  database.close()
  await fleet.close()
  if (savedKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = savedKey
  }
})

async function dispatchedSnapshot(): Promise<LocalWorkflowHostSnapshot> {
  const base = {
    version: 1,
    task: { prompt: 'Question', evidence: '' },
    synthesizerId: 'a',
    seats: SEATS.slice(0, 2),
    host: {
      workspaceId: 'w',
      conversationId: 'c',
      requestDigest: 'd',
      startedAt: NOW,
      concurrency: 2,
      sources: [],
      coverage: []
    }
  } as unknown as LocalWorkflowHostSnapshot
  const placement = await readyWorkflowFleetDispatch(PLACEMENT, base, { id: () => 'run-1' })
  return {
    ...base,
    seats: SEATS,
    host: { ...base.host, placement }
  } as LocalWorkflowHostSnapshot
}

function agentFor(snapshot: LocalWorkflowHostSnapshot, launch?: WorkflowAttemptLaunch) {
  const store = new WorkflowCheckpointStore(database.db)
  const executionId = store.create({
    conversationId: 'conversation',
    requestId: `request-${Math.random()}`,
    snapshot,
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 30
  })
  const directory = join(
    getAppEnvironment().getPath('userData'),
    'local-workflow-attempts',
    executionId
  )
  const seats = launch
    ? launch
    : launchWorkflowFleetSeats({
        snapshot,
        executionId,
        fence: 1,
        hostId: 'local:test',
        ownerIncarnation: 'owner-1',
        directory
      })
  const controller = new AbortController()
  const closeAdmission = vi.fn((error: Error) => controller.abort(error))
  const seatOf = (id: string) => SEATS.find((entry) => entry.id === id)!
  const agent = createDurableWorkflowAgent({
    store,
    executionId,
    fence: 1,
    slots: new WorkflowScriptSlots(2),
    signal: controller.signal,
    reservation: 10,
    seatFingerprint: (id) => JSON.stringify(seatOf(id)),
    route: (id) => seatOf(id).agent,
    launch: seats,
    attestNativeResult: ({ attemptId, parsed, call: { seatId } }) =>
      attestNativeResult({
        route: seatOf(seatId).agent,
        seat: seatOf(seatId),
        executionId,
        attemptId,
        parsed
      }),
    closeAdmission
  })
  return { agent, store, executionId, directory, closeAdmission }
}

function attempts(executionId: string) {
  return database.db
    .prepare(
      'SELECT id, call_id, state, receipt_json FROM local_workflow_attempts WHERE execution_id=? ORDER BY rowid'
    )
    .all(executionId) as { id: string; call_id: string; state: string; receipt_json: string }[]
}

describe.skipIf(process.platform === 'win32')('dispatched seats on a fleet host', () => {
  it('runs a Claude seat on the host with its own login, and keeps the receipt here', async () => {
    const snapshot = await dispatchedSnapshot()
    const f = agentFor(snapshot)
    expect(await f.agent(call('answers/a', 'a'))).toEqual({ answer: 'correct' })
    const [attempt] = attempts(f.executionId)
    expect(attempt).toMatchObject({ call_id: 'answers/a', state: 'accepted' })
    // The session the answer came from is the attempt's own id, on the host.
    expect(JSON.parse(attempt!.receipt_json).providerSessionId).toBe(attempt!.id)
    const root = snapshot.host.placement!.dispatch!.root
    const launch = JSON.parse(readFileSync(join(f.directory, attempt!.id, 'launch.json'), 'utf8'))
    expect(launch.dispatch).toEqual({
      host: 'mw0004',
      machine: 'mw0004',
      directory: `${root}/attempts/${attempt!.id}`
    })
    expect(existsSync(join(root, 'attempts', attempt!.id, 'pid'))).toBe(true)
    expect(await fleet.read('mw0004', `seat-${attempt!.id}.prompt`)).toBe(
      'Frozen question for answers/a'
    )
    expect((await fleet.read('mw0004', `seat-${attempt!.id}.cwd`)).trim()).toBe(
      await realpath(join(root, 'attempts', attempt!.id))
    )
    // No API key reaches the seat; only the workflow's own switch does.
    expect(await fleet.read('mw0004', `seat-${attempt!.id}.env`)).toBe('')
  })

  it('runs a Codex seat on a home linked to the host login and attests its session log', async () => {
    const snapshot = await dispatchedSnapshot()
    const f = agentFor(snapshot)
    expect(await f.agent(call('answers/b', 'b'))).toEqual({ answer: 'correct' })
    const [attempt] = attempts(f.executionId)
    expect(attempt!.state).toBe('accepted')
    expect((await fleet.read('mw0004', 'codex-auth-link')).trim()).toBe(
      join(await realpath(fleet.host('mw0004').home), '.codex', 'auth.json')
    )
    expect(await fleet.read('mw0004', 'codex.env')).toBe('')
    // The session log came home, where the attestation read it.
    const sessions = join(
      f.directory,
      'inputs',
      attempt!.id,
      'codex-home',
      'sessions',
      '2026',
      '09',
      '30'
    )
    expect((await readdir(sessions)).length).toBe(1)
    const remoteAuth = join(
      snapshot.host.placement!.dispatch!.root,
      'attempts',
      attempt!.id,
      'codex-home',
      'auth.json'
    )
    expect((await lstat(remoteAuth)).isSymbolicLink()).toBe(true)
  })

  it('runs Codex calls on one host at once while its login outlasts them', async () => {
    const snapshot = await dispatchedSnapshot()
    const { state, home } = fleet.host('mw0004')
    await writeFile(join(home, '.codex', 'auth.json'), fakeCodexLogin(Date.now() + 10 * DAY))
    await mkdir(join(state, 'codex-running'))
    const f = agentFor(snapshot)
    await expect(
      Promise.all([f.agent(call('answers/b1', 'b')), f.agent(call('answers/b2', 'b'))])
    ).resolves.toEqual([{ answer: 'correct' }, { answer: 'correct' }])
    // Each call met the other running on the host; nothing refreshed the login.
    expect((await fleet.read('mw0004', 'codex-overlap')).trim().split('\n')).toEqual(['2', '2'])
    expect(existsSync(join(state, 'codex-refreshes'))).toBe(false)
  })

  it('lets one Codex call refresh a login about to expire, then runs the rest at once', async () => {
    const snapshot = await dispatchedSnapshot()
    const { state, home } = fleet.host('mw0004')
    const login = join(home, '.codex', 'auth.json')
    await writeFile(login, fakeCodexLogin(Date.now() + 10 * 60_000))
    const fresh = fakeCodexLogin(Date.now() + 10 * DAY)
    await writeFile(join(state, 'codex-fresh-auth.json'), fresh)
    await mkdir(join(state, 'codex-running'))
    const f = agentFor(snapshot)
    const results = await Promise.all(
      ['b1', 'b2', 'b3'].map((id) => f.agent(call(`answers/${id}`, 'b')))
    )
    expect(results).toEqual(['b1', 'b2', 'b3'].map(() => ({ answer: 'correct' })))
    // One rotation, through the link to the host's login; the other two then overlapped.
    expect((await fleet.read('mw0004', 'codex-refreshes')).trim().split('\n')).toHaveLength(1)
    expect(await readFile(login, 'utf8')).toBe(fresh)
    expect((await fleet.read('mw0004', 'codex-overlap')).trim().split('\n')).toEqual(['2', '2'])
  })

  it('runs the Check the same way as every other seat: on the host', async () => {
    const snapshot = await dispatchedSnapshot()
    const f = agentFor(snapshot)
    expect(await f.agent(call('final/check', 'a'))).toEqual({ answer: 'correct' })
    const [attempt] = attempts(f.executionId)
    const launch = JSON.parse(readFileSync(join(f.directory, attempt!.id, 'launch.json'), 'utf8'))
    expect(launch.dispatch.host).toBe('mw0004')
  })

  it('refuses a seat the host cannot run, by name, without launching it here', async () => {
    const snapshot = await dispatchedSnapshot()
    const f = agentFor(snapshot)
    await expect(f.agent(call('answers/g', 'g'))).rejects.toThrow(
      'Workflow call exhausted its attempts: Grok cannot run on mw0004; its seats run Claude and Codex.'
    )
    expect(attempts(f.executionId).every((row) => JSON.parse(row.receipt_json).noLaunch)).toBe(true)
  })

  it('fails only the call after stopping a seat whose connection was lost', async () => {
    const snapshot = await dispatchedSnapshot()
    await writeFile(join(fleet.host('mw0004').state, 'drop-live'), '')
    const f = agentFor(snapshot)
    const failure = await f.agent(call('answers/a', 'a')).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      'Lost contact with mw0004 while answers/a ran there (ssh: Connection to fake closed by remote host.). Its seat process there is exited. The call failed; remaining steps can continue; nothing moved to this computer.'
    )
    expect(f.closeAdmission).not.toHaveBeenCalled()
    // Settled failed with the reason, and never tried again.
    const rows = attempts(f.executionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe('failed')
    const orphan = Number((await fleet.read('mw0004', 'orphan')).trim())
    await vi.waitFor(() => expect(() => process.kill(orphan, 0)).toThrow())
  })

  it('says the seat is unverifiable when the host cannot be reached again', async () => {
    const snapshot = await dispatchedSnapshot()
    await writeFile(join(fleet.host('mw0004').state, 'drop-lost'), '')
    const f = agentFor(snapshot)
    await expect(f.agent(call('answers/a', 'a'))).rejects.toThrow(
      'Lost contact with mw0004 during answers/a (ssh: client_loop: send disconnect: Broken pipe). Its seat process there is unverifiable. The run stopped; nothing moved to this computer.'
    )
  })

  it('never claims a seat state it could not read when the host refuses the connection', async () => {
    const snapshot = await dispatchedSnapshot()
    await writeFile(join(fleet.host('mw0004').state, 'lost'), '')
    const f = agentFor(snapshot)
    await expect(f.agent(call('answers/a', 'a'))).rejects.toThrow(
      'Lost contact with mw0004 during answers/a (ssh: connect to host mw0004 port 22: Operation timed out). Its seat process there is unverifiable. The run stopped; nothing moved to this computer.'
    )
  })

  it('does not retry on the same host after the seat is confirmed gone', async () => {
    const snapshot = await dispatchedSnapshot()
    const state = fleet.host('mw0004').state
    await writeFile(
      join(state, 'bin', 'perl'),
      '#!/bin/sh\necho "Connection reset by peer" >&2\nexit 255\n',
      { mode: 0o755 }
    )
    const f = agentFor(snapshot)
    await expect(f.agent(call('answers/a', 'a'))).rejects.toThrow(
      'The call failed; remaining steps can continue'
    )
    expect(attempts(f.executionId).map((row) => row.state)).toEqual(['failed'])
    expect(f.closeAdmission).not.toHaveBeenCalled()
  })
})

describe.skipIf(process.platform === 'win32')('a silent seat on a fleet host', () => {
  it('ends it on the host as well as here, and retries it there once', async () => {
    // Fake time jumps the deadline; it also follows real time so SSH and group checks still run.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const snapshot = await dispatchedSnapshot()
    await writeFile(join(fleet.host('mw0004').state, 'stall-live'), '')
    const f = agentFor(snapshot)
    const stalled = async () =>
      (await fleet.read('mw0004', 'stalled').catch(() => '')).split('\n').filter(Boolean)
    const answer = f
      .agent({ ...call('answers/a', 'a'), output: 'text', timeoutMs: 4 * WORKFLOW_CALL_STALL_MS })
      .catch((error: Error) => error)
    for (const seats of [1, 2]) {
      await vi.waitFor(async () => expect(await stalled()).toHaveLength(seats), { timeout: 10_000 })
      vi.advanceTimersByTime(WORKFLOW_CALL_STALL_MS)
    }
    expect(((await answer) as Error).message).toBe(
      'Workflow call exhausted its attempts: stalled: no output for 10:00, so it was ended'
    )
    const rows = attempts(f.executionId)
    expect(rows.map((row) => row.state)).toEqual(['failed', 'failed'])
    // ssh ended by the stall exits 255, as OpenSSH does on SIGTERM: still a stall, not a lost host.
    for (const row of rows) {
      const terminal = JSON.parse(readFileSync(join(f.directory, row.id, 'terminal.json'), 'utf8'))
      expect(terminal.result).toMatchObject({ code: 255, stalledAfterMs: WORKFLOW_CALL_STALL_MS })
    }
    expect(f.closeAdmission).not.toHaveBeenCalled()
    // Ending the SSH process alone leaves a seat on another computer running: both were stopped.
    for (const pid of (await stalled()).map(Number)) {
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 })
    }
  })
})

describe('a lost host in the execution service', () => {
  it('fails the run with the host named, after one attempt', async () => {
    const store = new WorkflowCheckpointStore(database.db)
    const launches: string[] = []
    const message =
      'Lost contact with mw0004 while answers/a ran there (ssh: Broken pipe). Its seat process there is unverifiable. The run stopped; nothing moved to this computer.'
    const service = new WorkflowExecutionService({
      store,
      slots: new WorkflowScriptSlots(1),
      reservation: 1,
      progress: vi.fn(),
      launch: () => async (input) => {
        launches.push(input.call.id)
        input.recordLaunch(input.attemptId)
        throw new WorkflowHostLostError(message, {
          result: { code: 255, signal: null, timedOut: false, stdout: '', stderr: 'Broken pipe' },
          receipt: {
            attemptId: input.attemptId,
            processReceiptRef: input.attemptId,
            liveness: 'exited'
          }
        })
      }
    })
    const id = service.start({
      conversationId: 'conversation',
      requestId: 'lost',
      snapshot: {
        version: 1,
        task: { prompt: 'Question', evidence: 'Frozen evidence' },
        synthesizerId: 'a',
        seats: SEATS,
        councilProgramRevision: 4,
        discover: {
          dimensions: ['correctness', 'security', 'usability'],
          lenses: ['evidence', 'alternatives'],
          minimumSeverity: 'medium',
          maxCandidates: 12
        }
      },
      preset: 'council',
      fence: 1,
      attemptLimit: 3,
      callLimit: 7,
      budgetLimit: 21
    })
    const outcome = await service.wait(id)
    expect(outcome).toMatchObject({ state: 'recovery_required', error: message })
    // One launch, and no second attempt or other seat after the host was lost.
    expect(launches).toHaveLength(1)
    const row = database.db
      .prepare('SELECT state, receipt_json FROM local_workflow_attempts')
      .get() as { state: string; receipt_json: string }
    expect(row.state).toBe('running')
    expect(JSON.parse(row.receipt_json).error).toBeUndefined()
  })
})
