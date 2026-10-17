import { z } from 'zod'
import { defineMethod, type RpcContext, type RpcAnyMethod } from '../core'

function owner(context: RpcContext): string {
  if (context.authenticatedCallerFingerprint) {
    return context.authenticatedCallerFingerprint
  }
  if (context.pairedDeviceId) {
    return `device:${context.pairedDeviceId}`
  }
  if (context.clientKind === undefined) {
    return 'local'
  }
  throw new Error('Provider sign-in requires an authenticated runtime connection.')
}

const sessionParams = z.object({ id: z.uuid() }).strict()

export const PROVIDER_LOGIN_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'accounts.login.start',
    params: z
      .object({
        provider: z.enum(['claude', 'codex']),
        accountId: z.string().min(1).max(512).optional(),
        runtime: z.enum(['host', 'wsl']).optional(),
        wslDistro: z.string().min(1).max(255).nullable().optional()
      })
      .strict(),
    handler: (params, context) =>
      context.runtime.providerLoginSessions.start(owner(context), params)
  }),
  defineMethod({
    name: 'accounts.login.status',
    params: sessionParams,
    handler: (params, context) =>
      context.runtime.providerLoginSessions.status(owner(context), params.id)
  }),
  defineMethod({
    name: 'accounts.login.submitCode',
    params: sessionParams.extend({ code: z.string().trim().min(1).max(4096) }).strict(),
    handler: (params, context) =>
      context.runtime.providerLoginSessions.submitCode(owner(context), params.id, params.code)
  }),
  defineMethod({
    name: 'accounts.login.cancel',
    params: sessionParams,
    handler: (params, context) =>
      context.runtime.providerLoginSessions.cancel(owner(context), params.id)
  })
]
