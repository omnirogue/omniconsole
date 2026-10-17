import { z } from 'zod'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { notifySettledDispatchMailbox } from '../../orchestration/settled-dispatch-mailbox'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { describeUnconfirmedAgentStop } from '../../../../shared/pty-liveness-verdict'
import { ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { readCanonicalWorkerRecord } from '../../orchestration/canonical-worker-record'
import {
  observeCanonicalWorker,
  recordCanonicalWorkerRootExit
} from '../../orchestration/canonical-worker-observation'
import {
  inspectWorkerTerminal,
  resolvePinnedFederatedServer
} from './orchestration-worker-observation'
import {
  interruptedWorkerStopReceipt,
  settledWorkerStopReceipt as settledReceipt,
  unknownWorkerStopReceipt as unknownReceipt,
  workerStopErrorReceipt
} from './orchestration-worker-stop-receipt'

const WorkerDispatchParams = z.object({ dispatch: requiredString('Missing --dispatch') })

export const ORCHESTRATION_WORKER_STOP_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStop',
    params: WorkerDispatchParams,
    handler: async (params, { runtime, orchestrationMutation }) => {
      const db = runtime.getOrchestrationDb()
      const canonicalRecord = readCanonicalWorkerRecord(db, params.dispatch)
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        if (!orchestrationMutation) {
          throw new OrchestrationError(
            'invalid_argument',
            'Remote worker-stop requires a durable retry request.'
          )
        }
        const server = resolvePinnedFederatedServer(runtime, federated)
        const begun = db.beginWorkerStop(params.dispatch, runtime.getRuntimeId())
        if (begun.disposition === 'already_settled') {
          return settledReceipt(params.dispatch, begun.worker.state)
        }
        if (begun.disposition === 'context_only') {
          if (!begun.alreadySettled) {
            notifySettledDispatchMailbox(runtime, db, params.dispatch)
            runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
          }
          return {
            dispatchId: params.dispatch,
            state: begun.state,
            alreadySettled: begun.alreadySettled,
            processAction: 'none' as const,
            warning: contextOnlyStopWarning(begun)
          }
        }
        try {
          const status = (await runtime.callOrchestrationWorkerServer(
            server.environmentId,
            'status.get',
            undefined,
            30_000
          )) as RuntimeStatus
          const afterStatus = interruptedWorkerStopReceipt(
            params.dispatch,
            db.getWorkerDispatch(params.dispatch)
          )
          if (afterStatus) {
            return afterStatus
          }
          if (
            !status.capabilities?.includes(ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY)
          ) {
            return unknownReceipt(
              params.dispatch,
              db.markWorkerStopUnknown(
                params.dispatch,
                `Connected server ${server.name} cannot prove the worker stop outcome.`
              ),
              'none'
            )
          }
          const remote = (await runtime.callOrchestrationWorkerServer(
            server.environmentId,
            'orchestration.federationStop',
            { dispatchId: params.dispatch },
            30_000,
            { orchestrationRequestId: orchestrationMutation.requestId }
          )) as RemoteStopReceipt
          const afterRemote = interruptedWorkerStopReceipt(
            params.dispatch,
            db.getWorkerDispatch(params.dispatch)
          )
          if (afterRemote) {
            return afterRemote
          }
          if (remote.state === 'stopped') {
            const worker = db.reconcileFederatedWorkerStop(params.dispatch)
            notifySettledDispatchMailbox(runtime, db, params.dispatch)
            runtime.recordOrchestrationExecutionObservation({
              runId: begun.dispatch.run_id,
              workerDispatchId: params.dispatch,
              event: 'stop_confirmed',
              detail: 'The owning worker host confirmed the process stopped.'
            })
            return {
              dispatchId: params.dispatch,
              state: worker.state,
              alreadySettled: remote.alreadySettled,
              processAction: remote.processAction,
              close: remote.close
            }
          }
          if (remote.state === 'succeeded' || remote.state === 'failed') {
            db.resumeFederatedWorkerForTerminalRelay(params.dispatch)
            await runtime
              .syncOrchestrationFederatedDispatchAfterCurrent(params.dispatch)
              .catch(() => undefined)
            return {
              dispatchId: params.dispatch,
              state: db.getWorkerDispatch(params.dispatch)?.state ?? remote.state,
              alreadySettled: true,
              processAction: 'none'
            }
          }
          return unknownReceipt(
            params.dispatch,
            db.markWorkerStopUnknown(
              params.dispatch,
              remote.lastError ?? `The worker server returned ${remote.state}.`
            ),
            remote.processAction
          )
        } catch (error) {
          return workerStopErrorReceipt(
            params.dispatch,
            error,
            () => db.getWorkerDispatch(params.dispatch),
            (reason) => db.markWorkerStopUnknown(params.dispatch, reason)
          )
        }
      }

      const begun = db.beginWorkerStop(params.dispatch, runtime.getRuntimeId())
      if (begun.disposition === 'already_settled') {
        return {
          ...settledReceipt(params.dispatch, begun.worker.state),
          ...(canonicalRecord
            ? { canonical: await observeCanonicalWorker(db, params.dispatch) }
            : {})
        }
      }
      if (begun.disposition === 'context_only') {
        if (!begun.alreadySettled) {
          notifySettledDispatchMailbox(runtime, db, params.dispatch)
          runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
        }
        return {
          dispatchId: params.dispatch,
          state: begun.state,
          alreadySettled: begun.alreadySettled,
          processAction: 'none' as const,
          warning: contextOnlyStopWarning(begun)
        }
      }
      const handle = begun.worker.agent_terminal_handle
      if (!handle) {
        return unknownReceipt(
          params.dispatch,
          db.markWorkerStopUnknown(params.dispatch, 'The Dispatch has no recorded agent terminal.'),
          'unknown'
        )
      }
      try {
        const observation = await inspectWorkerTerminal(runtime, db, params.dispatch)
        const afterInspection = interruptedWorkerStopReceipt(
          params.dispatch,
          db.getWorkerDispatch(params.dispatch)
        )
        if (afterInspection) {
          return afterInspection
        }
        // Why `unverifiable` still proceeds: losing contact is a reason to report
        // the outcome honestly, never a reason to stop trying to stop the worker.
        if (
          !observation.exact ||
          (observation.status !== 'live' && observation.status !== 'unverifiable')
        ) {
          return unknownReceipt(
            params.dispatch,
            db.markWorkerStopUnknown(
              params.dispatch,
              `The recorded worker process is ${observation.status}; no terminal was closed.`
            ),
            'none'
          )
        }
        const resource = db.getWorkerTerminalResourceByOwner(params.dispatch)
        if (!resource || resource.ownership_state !== 'owned') {
          const ownership = resource?.ownership_state ?? 'unproven'
          return unknownReceipt(
            params.dispatch,
            db.markWorkerStopUnknown(
              params.dispatch,
              `The worker terminal is ${ownership}; no terminal was closed.`
            ),
            'none'
          )
        }
        const exitWait = canonicalRecord
          ? runtime
              .waitForTerminal(handle, { condition: 'exit', timeoutMs: 10000 })
              .catch(() => null)
          : null
        const close = await runtime.closeTerminal(handle)
        if (!close.ptyKilled) {
          // The tab is retired, but the agent process was never confirmed stopped —
          // settling here is the false success this receipt exists to prevent.
          return unknownReceipt(
            params.dispatch,
            db.markWorkerStopUnknown(params.dispatch, describeUnconfirmedAgentStop(close)),
            'closed_agent_terminal'
          )
        }
        if (canonicalRecord) {
          const exit = await exitWait
          recordCanonicalWorkerRootExit(
            db,
            params.dispatch,
            exit?.exitCause?.kind === 'exited' ? exit.exitCause.exitCode : null,
            exit?.exitCause ?? { kind: 'operator_close' }
          )
        }
        const worker = db.settleWorkerStop(params.dispatch)
        notifySettledDispatchMailbox(runtime, db, params.dispatch)
        runtime.recordOrchestrationExecutionObservation({
          runId: begun.dispatch.run_id,
          workerDispatchId: params.dispatch,
          event: 'stop_confirmed',
          detail: 'The exact worker terminal was confirmed stopped.'
        })
        runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
        return {
          dispatchId: params.dispatch,
          state: worker.state,
          alreadySettled: false,
          processAction: 'closed_agent_terminal',
          close,
          ...(canonicalRecord
            ? { canonical: await observeCanonicalWorker(db, params.dispatch) }
            : {})
        }
      } catch (error) {
        return workerStopErrorReceipt(
          params.dispatch,
          error,
          () => db.getWorkerDispatch(params.dispatch),
          (reason) => db.markWorkerStopUnknown(params.dispatch, reason)
        )
      }
    }
  })
]

type RemoteStopReceipt = {
  state: string
  alreadySettled: boolean
  processAction: string
  close?: unknown
  lastError?: string | null
}

function contextOnlyStopWarning(result: {
  state: string
  alreadySettled: boolean
  releasedCurrentTask: boolean
}): string {
  if (result.alreadySettled) {
    return `Dispatch was already ${result.state}; no terminal process changed.`
  }
  return result.releasedCurrentTask
    ? 'The assignment was stopped without closing its unsupervised terminal process.'
    : 'The superseded assignment was stopped without changing the current Task or terminal process.'
}
