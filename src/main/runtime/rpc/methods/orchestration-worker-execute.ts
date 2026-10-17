import { join } from 'node:path'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import {
  canonicalProcessBirth,
  observeCanonicalWorker,
  readCanonicalGateObservation
} from '../../orchestration/canonical-worker-observation'
import {
  assertCanonicalWorkerAck,
  consumeCanonicalWorkerFile,
  exposeCanonicalWorker,
  readCanonicalWorkerRecord,
  updateCanonicalWorkerRecord,
  writeCanonicalWorkerFile
} from '../../orchestration/canonical-worker-record'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { inspectWorkerTerminal } from './orchestration-worker-observation'

export const ORCHESTRATION_WORKER_EXECUTE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerExecute',
    params: z.object({
      dispatch: requiredString('Missing --dispatch'),
      startReceiptFile: requiredString('Missing --start-receipt-file')
    }),
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const record = readCanonicalWorkerRecord(db, params.dispatch)
      if (!record) {
        throw new OrchestrationError('dispatch_not_found', 'Canonical worker was not found.')
      }
      const answer = consumeCanonicalWorkerFile(params.startReceiptFile)
      assertCanonicalWorkerAck(answer, record)
      const dispatch = db.getDispatchContextById(params.dispatch)!
      const worker = db.getWorkerDispatch(params.dispatch)!
      if (record.phase === 'released' || record.phase === 'exited') {
        if (
          record.phase === 'released' &&
          readCanonicalGateObservation(record.gateDirectory)?.phase !== 'released'
        ) {
          let permit: unknown
          try {
            permit = consumeCanonicalWorkerFile(join(record.gateDirectory, 'permit.json'), false)
          } catch {
            permit = null
          }
          if (
            !isDeepStrictEqual(permit, {
              nonce: record.gateNonce,
              binding_hash: record.bindingHash,
              ...record.processIdentity
            })
          ) {
            updateCanonicalWorkerRecord(db, params.dispatch, { phase: 'unknown' })
            if (worker.state === 'ready') {
              db.recordWorkerStage({
                dispatchId: params.dispatch,
                state: 'start_unknown',
                stage: 'canonical_release_unknown'
              })
            }
            throw new OrchestrationError(
              'operation_unknown',
              'Provider release intent has no observed permit; inspect and stop this dispatch.'
            )
          }
        }
        return {
          runId: dispatch.run_id,
          taskId: dispatch.task_id,
          dispatchId: params.dispatch,
          state: worker.state,
          stage: worker.stage,
          canonical: await observeCanonicalWorker(db, params.dispatch)
        }
      }
      if (
        worker.runtime_epoch !== runtime.getRuntimeId() ||
        worker.state !== 'starting' ||
        worker.stage !== 'awaiting_hub_start' ||
        dispatch.capability_revoked_at
      ) {
        throw new OrchestrationError(
          'consumer_fenced',
          'This prepared worker is no longer eligible for provider execution.'
        )
      }
      const observation = await inspectWorkerTerminal(runtime, db, params.dispatch)
      const gate = readCanonicalGateObservation(record.gateDirectory)
      if (
        !observation.exact ||
        observation.status !== 'live' ||
        !record.processIdentity ||
        !gate ||
        gate.phase !== 'prepared' ||
        gate.launch_gate_closed !== true ||
        gate.binding_hash !== record.bindingHash ||
        gate.pid !== record.processIdentity.pid ||
        gate.pgid !== gate.pid ||
        gate.started_at !== record.processIdentity.started_at ||
        gate.runner_instance !== record.processIdentity.runner_instance ||
        (await canonicalProcessBirth(record.processIdentity)) !== 'current'
      ) {
        throw new OrchestrationError(
          'consumer_fenced',
          'The exact closed provider gate is not observable.'
        )
      }
      // No await between the final fence, durable release intent and permit publication.
      const current = db.getWorkerDispatch(params.dispatch)!
      const currentDispatch = db.getDispatchContextById(params.dispatch)
      const currentRun = db.getRun(dispatch.run_id)
      const currentTask = db.getTask(dispatch.task_id)
      if (
        current.runtime_epoch !== runtime.getRuntimeId() ||
        current.state !== 'starting' ||
        current.stage !== 'awaiting_hub_start' ||
        currentDispatch?.status !== 'pending' ||
        currentDispatch.capability_revoked_at ||
        currentRun?.consumer_generation !== record.runGeneration ||
        currentRun.hub_task_id !== record.binding.task_id ||
        currentTask?.status !== 'dispatched' ||
        currentTask.hub_task_id !== record.binding.task_id
      ) {
        throw new OrchestrationError(
          'consumer_fenced',
          'This canonical worker was stopped before execution.'
        )
      }
      const job = (
        answer as {
          job: { execution_start_receipt: { attempt_id?: unknown; session_id?: unknown } }
        }
      ).job
      const released = updateCanonicalWorkerRecord(db, params.dispatch, {
        phase: 'released',
        startReceipt: {
          attempt_id: job.execution_start_receipt.attempt_id,
          session_id: job.execution_start_receipt.session_id
        }
      })
      db.markWorkerDispatchReady(params.dispatch)
      db.recordWorkerStage({ dispatchId: params.dispatch, stage: 'canonical_start_acknowledged' })
      try {
        writeCanonicalWorkerFile(join(record.gateDirectory, 'permit.json'), {
          nonce: record.gateNonce,
          binding_hash: record.bindingHash,
          ...record.processIdentity
        })
      } catch {
        updateCanonicalWorkerRecord(db, params.dispatch, { phase: 'unknown' })
        db.recordWorkerStage({
          dispatchId: params.dispatch,
          state: 'start_unknown',
          stage: 'canonical_release_unknown'
        })
        db.db
          .prepare(
            "UPDATE dispatch_contexts SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now')) WHERE id = ?"
          )
          .run(params.dispatch)
        throw new OrchestrationError(
          'operation_unknown',
          'Provider release was not confirmed; inspect and stop this exact dispatch.'
        )
      }
      return {
        runId: dispatch.run_id,
        taskId: dispatch.task_id,
        dispatchId: params.dispatch,
        state: 'ready',
        stage: 'canonical_start_acknowledged',
        canonical: exposeCanonicalWorker(released)
      }
    }
  })
]
