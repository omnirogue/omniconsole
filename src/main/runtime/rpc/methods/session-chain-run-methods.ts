import { z } from 'zod'
import { auditSessionRuns } from '../../../../shared/session-run-audit'
import { sessionOutcomeProgress } from '../../../../shared/session-outcome-state'
import { assertSessionOutcomeUser } from '../../session-outcome-authority'
import { assertSessionOutcomeRuntime } from '../../session-outcome-host-boundary'
import { sessionOutcomeProgressSourceRefusal } from '../../session-outcome-progress-source'
import { isSealedOutcomeChain } from '../../session-outcome-source-uniqueness'
import { upNextHeldContinuation } from '../../up-next-held-gates'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const ExecutionRuntimeId = z.string().min(1).optional()
const OperationId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Invalid operation id')

/**
 * Reading a run, reporting what a window did with a finished session, and asking the host to
 * converge. Reads here are pure: looking at a run resolves nothing and announces nothing
 * (`docs/reference/session-run-lifecycle.md`).
 */
export const SESSION_CHAIN_RUN_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'sessionChain.outcomeProgress',
    params: z.object({
      id: requiredString('Missing chain id'),
      expectedExecutionRuntimeId: ExecutionRuntimeId,
      verifySourceReady: z.boolean().optional()
    }),
    handler: async (params, context) => {
      assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
      const { runtime } = context
      const service = runtime.getSessionOutcomeService()
      const chain = service.get(params.id)
      const progress = sessionOutcomeProgress(chain.outcomeSet!, {
        now: service.now(),
        planVersion: chain.planVersion ?? 1
      })
      // Sealed success is final: a source that moved on afterwards is about some later run.
      const refusal =
        params.verifySourceReady &&
        progress.lifecycle === 'complete' &&
        !isSealedOutcomeChain(chain)
          ? await sessionOutcomeProgressSourceRefusal(runtime, chain)
          : null
      return refusal ? { chain, ...progress, ...refusal } : { chain, ...progress }
    }
  }),
  defineMethod({
    name: 'sessionChain.reportDisposition',
    params: z
      .object({
        chainId: requiredString('Missing chain id'),
        expectedExecutionRuntimeId: ExecutionRuntimeId,
        operationId: OperationId,
        ok: z.boolean(),
        error: z.string().trim().min(1).max(1_000).optional()
      })
      .strict(),
    handler: async (params, context) => {
      assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
      // Closing or saving is a window fact; an agent cannot assert that it happened.
      assertSessionOutcomeUser(context)
      return {
        chain: await context.runtime.getSessionOutcomeService().reportDisposition(params.chainId, {
          operationId: params.operationId,
          ok: params.ok,
          ...(params.error ? { error: params.error } : {})
        })
      }
    }
  }),
  defineMethod({
    name: 'sessionChain.retryDisposition',
    params: z
      .object({
        chainId: requiredString('Missing chain id'),
        expectedExecutionRuntimeId: ExecutionRuntimeId
      })
      .strict(),
    handler: async (params, context) => {
      assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
      assertSessionOutcomeUser(context)
      return {
        chain: await context.runtime.getSessionOutcomeService().retryDisposition(params.chainId)
      }
    }
  }),
  defineMethod({
    name: 'sessionChain.reconcile',
    params: z.object({ expectedExecutionRuntimeId: ExecutionRuntimeId }).strict(),
    handler: async (params, context) => {
      assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
      await context.runtime.getSessionOutcomeService().reconcile('refresh')
      return { reconciled: true }
    }
  }),
  defineMethod({
    name: 'sessionChain.auditRuns',
    params: z.object({ expectedExecutionRuntimeId: ExecutionRuntimeId }).strict(),
    handler: (params, context) => {
      assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
      const { runtime } = context
      const chains = runtime.listSessionChains()
      // Read-only: it lists what reconciliation would repair and repairs nothing itself.
      return {
        rows: auditSessionRuns(chains, runtime.getSessionOutcomeService().now(), (chain) =>
          upNextHeldContinuation(runtime, chain, chains)
        )
      }
    }
  })
]
