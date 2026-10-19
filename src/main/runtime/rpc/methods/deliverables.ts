import { z } from 'zod'
import { DELIVERABLE_VERIFICATION_RPC } from '../../../../shared/deliverable-verification-types'
import { getDeliverableVerifier } from '../../../deliverable-verifier/deliverable-verifier-slot'
import { defineMethod, type RpcAnyMethod } from '../core'

/**
 * The deliverable check's records on the host that ran the session (W22-20). Additive methods: a
 * client asking an older host gets `method_not_found` and shows no Deliverables block.
 */
export const DELIVERABLE_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: DELIVERABLE_VERIFICATION_RPC.list,
    params: z.object({ paneKey: z.string().min(1).max(4_096) }).strict(),
    handler: (params) => getDeliverableVerifier()?.records(params.paneKey) ?? []
  }),
  defineMethod({
    name: DELIVERABLE_VERIFICATION_RPC.markFalseAlarm,
    params: z.object({ id: z.string().min(1).max(200) }).strict(),
    handler: (params) => getDeliverableVerifier()?.markFalseAlarm(params.id) ?? null
  })
]
