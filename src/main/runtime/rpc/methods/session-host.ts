import { z } from 'zod'
import { SESSION_HOST_RPC } from '../../../../shared/session-host-protocol'
import { handleRuntimeSessionHostCall } from '../../../session-host/session-host-runtime'
import { defineMethod, type RpcMethod } from '../core'

// Why raw params: a shape failure must come back as an `invalid-request` refusal VALUE, and relay
// JSON-RPC would rebuild an error with a numeric code; the strict schemas run inside the gate.
const RAW_PARAMS = z.unknown()

export const SESSION_HOST_METHODS: RpcMethod[] = Object.values(SESSION_HOST_RPC).map((name) =>
  defineMethod({
    name,
    params: RAW_PARAMS,
    handler: async (params, ctx) => await handleRuntimeSessionHostCall(name, params, ctx)
  })
)
