import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../../../shared/app-environment'
import type { CanonicalWorkerProcessIdentity } from '../../../../shared/canonical-worker-execution'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { createHubTaskProjection } from '../../orchestration/db/tasks/task-store'
import {
  canonicalProcessBirth,
  observeCanonicalProcessIdentity
} from '../../orchestration/canonical-worker-observation'
import type * as CanonicalWorkerObservation from '../../orchestration/canonical-worker-observation'
import {
  readCanonicalWorkerRecord,
  updateCanonicalWorkerRecord,
  type CanonicalWorkerRecord
} from '../../orchestration/canonical-worker-record'
import { ORCHESTRATION_WORKER_CONTROL_METHODS } from './orchestration-worker-control'
import { ORCHESTRATION_WORKER_EXECUTE_METHODS } from './orchestration-worker-execute'
import { ORCHESTRATION_WORKER_PREPARE_METHODS } from './orchestration-worker-prepare'

vi.mock('../../orchestration/canonical-worker-observation', async (importOriginal) => ({
  ...(await importOriginal<typeof CanonicalWorkerObservation>()),
  canonicalProcessBirth: vi.fn(),
  observeCanonicalProcessIdentity: vi.fn()
}))

type StartAck = {
  ok: boolean
  job: {
    id: unknown
    attempt: unknown
    claimed_at: unknown
    runner_instance: string
    status: string
    cancel_requested: boolean
    terminal_proof: unknown
    execution_binding: Record<string, unknown>
    process_identity: CanonicalWorkerProcessIdentity
    execution_start_receipt: {
      started: boolean
      binding: Record<string, unknown>
      session_id: string
    }
  }
}

describe.skipIf(process.platform === 'win32')('canonical worker RPC lifecycle', () => {
  const coordinatorPane = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPane = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const processIdentity = {
    pid: 424242,
    started_at: 'Wed Sep 9 12:00:00 2026',
    runner_instance: 'runner_1'
  }
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let directory: string
  let runId: string
  let taskId: string
  let fileSequence: number
  let binding: Record<string, unknown>

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'canonical-worker-rpc-'))
    fileSequence = 0
    setAppEnvironment({
      getPath: () => directory,
      getAppPath: () => process.cwd(),
      getVersion: () => '0.0.0-test',
      isPackaged: () => false,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
    vi.mocked(canonicalProcessBirth).mockReset().mockResolvedValue('current')
    vi.mocked(observeCanonicalProcessIdentity).mockReset().mockResolvedValue(processIdentity)
    db = new OrchestrationDb(':memory:')
    runId = db.createRun({
      objective: 'Canonical worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: coordinatorPane
    }).id
    db.bindRunToHub({ runId, hubTaskId: 'btk_canonical', hubStateRevision: 1 })
    taskId = createHubTaskProjection(db, {
      runId,
      hubTaskId: 'btk_canonical',
      title: 'Canonical worker'
    }).id
    binding = {
      task_id: 'btk_canonical',
      job_id: 'job_1',
      attempt: 1,
      claimed_at: '2026-09-09T12:00:00Z',
      runner_instance: 'runner_1',
      contract_id: 'contract_1',
      contract_digest: 'digest_1',
      contract_generation: 1,
      dispatch_key: 'dispatch_1',
      attempt_intent_id: 'intent_1',
      host: 'host_1',
      claim_request_id: 'claim_1'
    }
    runtime = {
      getOrchestrationDb: () => db,
      getRuntimeId: vi.fn(() => 'runtime_1'),
      getTerminalPaneKey: vi.fn((handle: string) =>
        handle === 'term_coord' ? coordinatorPane : workerPane
      ),
      getTerminalProcessIncarnation: vi.fn(() => 'pty_worker:incarnation_1'),
      getOrchestrationDispatchAuthority: vi.fn(() => null),
      getNestedWorkerMaxDepth: () => 3,
      showManagedTerminalWorkspace: vi.fn(async () => ({
        id: 'folder_1',
        repoId: 'repo_1',
        path: directory
      })),
      showRepo: vi.fn(async () => ({ id: 'repo_1', kind: 'local' })),
      showTerminal: vi.fn(async () => ({
        handle: 'term_worker',
        worktreeId: 'folder_1',
        connected: true
      })),
      getTerminalLivenessVerdict: vi.fn(() => ({ status: 'live', ptyIds: ['pty_worker'] })),
      sendTerminalAgentPrompt: vi.fn(),
      createTerminal: vi.fn(async () => {
        const dispatchId = db.getDispatchContext(taskId)!.id
        const record = readCanonicalWorkerRecord(db, dispatchId)!
        unlinkSync(join(record.gateDirectory, 'launch.json'))
        writeFileSync(
          join(record.gateDirectory, 'process.json'),
          JSON.stringify({
            ...processIdentity,
            pgid: processIdentity.pid,
            binding_hash: record.bindingHash,
            phase: 'prepared',
            launch_gate_closed: true
          }),
          { mode: 0o600 }
        )
        return { handle: 'term_worker', processId: processIdentity.pid }
      })
    } as unknown as OrcaRuntimeService
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const methods = [
    ...ORCHESTRATION_WORKER_PREPARE_METHODS,
    ...ORCHESTRATION_WORKER_EXECUTE_METHODS,
    ...ORCHESTRATION_WORKER_CONTROL_METHODS
  ]

  async function call(name: string, params: Record<string, unknown>) {
    const method = methods.find((candidate) => candidate.name === `orchestration.${name}`)!
    return method.handler(method.params!.parse(params), { runtime }) as Promise<
      Record<string, unknown>
    >
  }

  function privateFile(value: unknown, mode = 0o600): string {
    const file = join(directory, `input-${++fileSequence}.json`)
    writeFileSync(file, JSON.stringify(value), { mode })
    chmodSync(file, mode)
    return file
  }

  function launch(executionBinding = binding) {
    return {
      binding: executionBinding,
      runnerInstance: 'runner_1',
      argv: ['/test/provider', '--credential', 'ARGV_SECRET'],
      env: { PROVIDER_SECRET: 'ENV_SECRET' },
      cwd: directory,
      gatePython: process.execPath
    }
  }

  function prepare(executionFile = privateFile(launch())) {
    return call('workerPrepare', {
      task: taskId,
      run: runId,
      from: 'term_coord',
      worktree: 'folder_1',
      executionFile
    })
  }

  function record(): CanonicalWorkerRecord {
    return readCanonicalWorkerRecord(db, db.getDispatchContext(taskId)!.id)!
  }

  function ack(): StartAck {
    return {
      ok: true,
      job: {
        id: binding.job_id,
        attempt: binding.attempt,
        claimed_at: binding.claimed_at,
        runner_instance: processIdentity.runner_instance,
        status: 'running',
        cancel_requested: false,
        terminal_proof: null,
        execution_binding: { ...binding },
        process_identity: { ...processIdentity },
        execution_start_receipt: { started: true, binding: { ...binding }, session_id: 'session_1' }
      }
    }
  }

  function execute(answer = ack(), receiptFile = privateFile(answer)) {
    return call('workerExecute', {
      dispatch: db.getDispatchContext(taskId)!.id,
      startReceiptFile: receiptFile
    })
  }

  it.each([
    ['another task', { task_id: 'btk_other' }],
    ['another runner', { runner_instance: 'runner_other' }],
    ['an incomplete claim', { claim_request_id: null }],
    ['an invalid attempt', { attempt: 0 }]
  ] as const)('refuses %s before creating a dispatch or terminal', async (_label, changes) => {
    await expect(prepare(privateFile(launch({ ...binding, ...changes })))).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(db.getDispatchContext(taskId)).toBeUndefined()
  })

  it.each(['mode', 'owner', 'symlink'] as const)(
    'refuses an execution file with invalid %s',
    async (kind) => {
      let file = privateFile(launch(), kind === 'mode' ? 0o644 : 0o600)
      if (kind === 'owner') {
        vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1)
      }
      if (kind === 'symlink') {
        const target = file
        file = join(directory, 'execution-link.json')
        symlinkSync(target, file)
      }
      await expect(prepare(file)).rejects.toThrow()
      expect(runtime.createTerminal).not.toHaveBeenCalled()
      expect(db.getDispatchContext(taskId)).toBeUndefined()
    }
  )

  it('holds provider input behind the closed gate and exposes no launch secrets', async () => {
    const executionFile = privateFile(launch())
    const prepared = await prepare(executionFile)
    const dispatchId = db.getDispatchContext(taskId)!.id
    expect(prepared).toMatchObject({
      state: 'starting',
      stage: 'awaiting_hub_start',
      canonical: { phase: 'prepared', processIdentity }
    })
    expect(existsSync(executionFile)).toBe(false)
    expect(existsSync(join(record().gateDirectory, 'permit.json'))).toBe(false)
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      'id:folder_1',
      expect.objectContaining({ envToDelete: ['OMNI_TASK_ID', 'OMNIOS_URL'] })
    )
    expect(JSON.stringify(vi.mocked(runtime.createTerminal).mock.calls)).not.toMatch(
      /ARGV_SECRET|ENV_SECRET|\/test\/provider/
    )
    const shown = await call('workerShow', { dispatch: dispatchId })
    expect(shown).toMatchObject({
      canonical: { phase: 'prepared', processIdentity },
      observation: { exactWorker: true, status: 'live' }
    })
    expect(JSON.stringify(shown)).not.toMatch(
      /ARGV_SECRET|ENV_SECRET|gateNonce|gateDirectory|launchDigest/
    )
    expect(db.getWorkerDispatch(dispatchId)!.start_options).not.toMatch(
      /ARGV_SECRET|ENV_SECRET|"argv"|"env"/
    )
    await expect(execute()).resolves.toMatchObject({
      state: 'ready',
      canonical: { phase: 'released', processIdentity }
    })
    expect(JSON.parse(readFileSync(join(record().gateDirectory, 'permit.json'), 'utf8'))).toEqual({
      nonce: record().gateNonce,
      binding_hash: record().bindingHash,
      ...processIdentity
    })
  })

  it('reuses an identical preparation and rejects a changed claim without another terminal', async () => {
    const prepared = await prepare()
    await expect(prepare()).resolves.toEqual(prepared)
    await expect(
      prepare(privateFile(launch({ ...binding, claim_request_id: 'claim_2' })))
    ).rejects.toMatchObject({ code: 'request_mismatch' })
    expect(runtime.createTerminal).toHaveBeenCalledOnce()
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM worker_dispatches').get()).toEqual({
      count: 1
    })
  })

  const badAcks: [string, (answer: StartAck) => void][] = [
    [
      'binding',
      (answer) => {
        answer.job.execution_binding.contract_digest = 'wrong'
      }
    ],
    [
      'receipt binding',
      (answer) => {
        answer.job.execution_start_receipt.binding.claim_request_id = 'wrong'
      }
    ],
    [
      'process birth',
      (answer) => {
        answer.job.process_identity.started_at = 'wrong'
      }
    ],
    [
      'process pid',
      (answer) => {
        answer.job.process_identity.pid += 1
      }
    ],
    [
      'runner',
      (answer) => {
        answer.job.runner_instance = 'wrong'
      }
    ],
    [
      'claim',
      (answer) => {
        answer.job.claimed_at = 'wrong'
      }
    ],
    [
      'attempt',
      (answer) => {
        answer.job.attempt = 2
      }
    ],
    [
      'cancellation',
      (answer) => {
        answer.job.cancel_requested = true
      }
    ],
    [
      'terminal proof',
      (answer) => {
        answer.job.terminal_proof = { kind: 'exited' }
      }
    ],
    [
      'status',
      (answer) => {
        answer.job.status = 'claimed'
      }
    ],
    [
      'start receipt',
      (answer) => {
        answer.job.execution_start_receipt.started = false
      }
    ],
    [
      'session receipt',
      (answer) => {
        answer.job.execution_start_receipt.session_id = ''
      }
    ],
    [
      'acknowledgement',
      (answer) => {
        answer.ok = false
      }
    ]
  ]

  it.each(badAcks)(
    'rejects a mismatched Hub %s before publishing a permit',
    async (_label, change) => {
      await prepare()
      const answer = ack()
      change(answer)
      await expect(execute(answer)).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(record().phase).toBe('prepared')
      expect(existsSync(join(record().gateDirectory, 'permit.json'))).toBe(false)
    }
  )

  it.each(['mode', 'owner'] as const)(
    'refuses a start receipt file with invalid %s',
    async (kind) => {
      await prepare()
      const file = privateFile(ack(), kind === 'mode' ? 0o644 : 0o600)
      if (kind === 'owner') {
        vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1)
      }
      await expect(execute(ack(), file)).rejects.toThrow()
      expect(existsSync(join(record().gateDirectory, 'permit.json'))).toBe(false)
    }
  )

  it.each(['abandoned', 'stale epoch', 'revoked'] as const)(
    'refuses execution after %s',
    async (condition) => {
      await prepare()
      const dispatchId = db.getDispatchContext(taskId)!.id
      if (condition === 'abandoned') {
        db.abandonWorkerDispatch(dispatchId)
      }
      if (condition === 'stale epoch') {
        vi.mocked(runtime.getRuntimeId).mockReturnValue('runtime_2')
      }
      if (condition === 'revoked') {
        db.revokeDispatchCapability(dispatchId)
      }
      await expect(execute()).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(existsSync(join(record().gateDirectory, 'permit.json'))).toBe(false)
    }
  )

  it('rechecks capability revocation after awaited process verification', async () => {
    await prepare()
    vi.mocked(canonicalProcessBirth).mockImplementationOnce(async () => {
      db.revokeDispatchCapability(db.getDispatchContext(taskId)!.id)
      return 'current'
    })
    await expect(execute()).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(existsSync(join(record().gateDirectory, 'permit.json'))).toBe(false)
  })

  it('does not report ready when the permit cannot be published', async () => {
    await prepare()
    mkdirSync(join(record().gateDirectory, 'permit.json'))
    const result = await execute().catch((error: unknown) => error)
    expect(result).not.toMatchObject({ state: 'ready' })
    expect(db.getWorkerDispatch(db.getDispatchContext(taskId)!.id)!.state).not.toBe('ready')
    const retry = await execute().catch((error: unknown) => error)
    expect(retry).not.toMatchObject({ state: 'ready' })
  })

  it('does not mistake durable release intent for a published permit after restart', async () => {
    await prepare()
    const dispatchId = db.getDispatchContext(taskId)!.id
    updateCanonicalWorkerRecord(db, dispatchId, { phase: 'released' })
    db.markWorkerDispatchReady(dispatchId)
    db.recordWorkerStage({ dispatchId, stage: 'canonical_start_acknowledged' })
    vi.mocked(runtime.getRuntimeId).mockReturnValue('runtime_2')
    const result = await execute().catch((error: unknown) => error)
    expect(result).not.toMatchObject({ state: 'ready' })
    expect(existsSync(join(record().gateDirectory, 'permit.json'))).toBe(false)
  })

  it('fences a concurrent execution request after the first publishes its permit', async () => {
    await prepare()
    const results = await Promise.allSettled([execute(), execute()])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(existsSync(join(record().gateDirectory, 'permit.json'))).toBe(true)
  })
})
