import {
  JEV_RECORD_METHODS,
  jevOutcomeParamsSchema,
  jevRecordsExportSchema,
  jevRecordsListSchema
} from '../../../../shared/jev-ledger'
import { getStructuredDecisionRuntime } from '../../../structured-decisions/decision-runtime'
import { defineMethod, type RpcMethod } from '../core'

/** The selected runtime's JEV ledger: read call rows, export them, append independent labels. */
export const JEV_RECORD_RPC_METHODS: RpcMethod[] = [
  defineMethod({
    name: JEV_RECORD_METHODS.list,
    params: jevRecordsListSchema,
    handler: (params, { runtime }) => getStructuredDecisionRuntime(runtime).listRecords(params)
  }),
  defineMethod({
    name: JEV_RECORD_METHODS.export,
    params: jevRecordsExportSchema,
    handler: (params, { runtime }) => getStructuredDecisionRuntime(runtime).exportRecords(params)
  }),
  defineMethod({
    name: JEV_RECORD_METHODS.outcome,
    params: jevOutcomeParamsSchema,
    handler: (params, { runtime }) => getStructuredDecisionRuntime(runtime).recordOutcome(params)
  })
]
