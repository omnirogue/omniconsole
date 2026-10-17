import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../omni-runtime'
import { OrchestrationDb } from '../orchestration/db'
import type { RpcRequest } from './core'
import {
  OrchestrationMutationExecutor,
  type DurableMutationInvocation
} from './orchestration-mutation-executor'

describe('durable worker preparation and execution', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
  })

  function createHarness(method: string, params: Record<string, unknown>) {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const runtime = {
      getOrchestrationDb: () => db,
      getTerminalPaneKey: () => undefined
    } as unknown as OrcaRuntimeService
    const request: RpcRequest = {
      id: 'rpc_worker_barrier',
      authToken: 'caller-token',
      method,
      params,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'mutation_worker_barrier'
    }
    const identity = {
      callerFingerprint: db.getOrCreateLocalMutationCallerFingerprint(),
      requestId: request.orchestrationRequestId!,
      method,
      payloadHash: createHash('sha256').update(JSON.stringify({ method, params })).digest('hex')
    }
    return { db, runtime, request, identity, executor: new OrchestrationMutationExecutor(runtime) }
  }

  it('accepts preparation with its Dispatch atomically and replays the completed receipt', async () => {
    const { db, runtime, request, identity, executor } = createHarness(
      'orchestration.workerPrepare',
      { task: 'task_prepare' }
    )
    const task = db.createTask({ spec: 'prepare a worker' })
    const prepare = vi.fn((mutation?: DurableMutationInvocation) => {
      expect(mutation?.identity).toEqual(identity)
      if (!mutation) {
        throw new Error('Worker preparation requires a durable mutation identity.')
      }
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: {},
        mutationReceipt: mutation.identity
      })
      return { state: 'starting', stage: 'prepared', dispatchId: started.dispatch.id }
    })

    const prepared = await executor.run(request, request.params, prepare)
    const replay = await new OrchestrationMutationExecutor(runtime).run(
      { ...request, id: 'rpc_worker_barrier_replay' },
      request.params,
      prepare
    )

    expect(prepared).toMatchObject({ state: 'starting', mutation: { replayed: false } })
    expect(replay).toEqual({
      ...(prepared as Record<string, unknown>),
      mutation: { requestId: identity.requestId, replayed: true }
    })
    expect(prepare).toHaveBeenCalledOnce()
    expect(db.getMutationReceipt(identity.callerFingerprint, identity.requestId)?.state).toBe(
      'completed'
    )
  })

  it.each(['orchestration.workerStart', 'orchestration.workerPrepare'])(
    'recovers the accepted Dispatch for interrupted %s without repeating acceptance',
    async (method) => {
      const { db, request, identity, executor } = createHarness(method, { task: 'task_prepare' })
      const task = db.createTask({ spec: 'recover accepted preparation' })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: {},
        mutationReceipt: identity
      })
      const prepare = vi.fn()

      await expect(executor.run(request, request.params, prepare)).rejects.toMatchObject({
        code: 'operation_unknown',
        data: {
          requestId: identity.requestId,
          dispatchId: started.dispatch.id,
          recoveryCommand: `omni orchestration worker-show --dispatch ${started.dispatch.id} --json`
        }
      })
      expect(prepare).not.toHaveBeenCalled()
      expect(db.getMutationReceipt(identity.callerFingerprint, identity.requestId)?.state).toBe(
        'pending'
      )
    }
  )

  it('records execution before invoking it and replays its completed receipt', async () => {
    const { db, runtime, request, identity, executor } = createHarness(
      'orchestration.workerExecute',
      { dispatch: 'ctx_prepared' }
    )
    const execute = vi.fn(() => {
      expect(db.getMutationReceipt(identity.callerFingerprint, identity.requestId)?.state).toBe(
        'pending'
      )
      return { state: 'ready', dispatchId: 'ctx_prepared' }
    })

    await expect(executor.run(request, request.params, execute)).resolves.toMatchObject({
      state: 'ready',
      mutation: { replayed: false }
    })
    await expect(
      new OrchestrationMutationExecutor(runtime).run(request, request.params, execute)
    ).resolves.toMatchObject({ state: 'ready', mutation: { replayed: true } })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('does not resume an execution left pending by a previous process', async () => {
    const { db, request, identity, executor } = createHarness('orchestration.workerExecute', {
      dispatch: 'ctx_prepared'
    })
    db.beginMutationReceipt(identity)
    const execute = vi.fn()

    await expect(executor.run(request, request.params, execute)).rejects.toMatchObject({
      code: 'operation_unknown',
      data: { requestId: identity.requestId }
    })
    expect(execute).not.toHaveBeenCalled()
    expect(db.getMutationReceipt(identity.callerFingerprint, identity.requestId)?.state).toBe(
      'pending'
    )
  })
})
