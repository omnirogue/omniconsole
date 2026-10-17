/**
 * How a client declares its Phase 4 session host support on an SSH relay connection. A paired
 * runtime reads the declaration from the authenticated socket's `clientCapabilities`; a relay has no
 * such handshake field, so the client sends this once per connection before any `sessionHost.*`
 * call. A reconnect drops it, and the relay answers `renegotiate` until the client declares again.
 */

import { z } from 'zod'
import { SESSION_HOST_MAX_ADVERTISED } from './session-host-capabilities'
import { sessionHostIdSchema } from './session-host-payload-schema'
import type { SessionHostRefusal } from './session-host-refusal'

export const SESSION_HOST_RELAY_DECLARE_METHOD = 'sessionHost.declareClient' as const

/**
 * `client` is the requesting computer's own session host id: stable across reconnects, so a
 * reservation it holds survives them. Anyone able to reach the relay already has the account's
 * shell, so this names the holder; it grants nothing.
 */
export const SessionHostRelayDeclarationSchema = z
  .object({
    capabilities: z.array(z.string().min(1).max(128)).max(SESSION_HOST_MAX_ADVERTISED),
    client: sessionHostIdSchema
  })
  .strict()
export type SessionHostRelayDeclaration = z.infer<typeof SessionHostRelayDeclarationSchema>

export type SessionHostRelayDeclarationResult =
  | { status: 'ok' }
  | { status: 'refused'; refusal: SessionHostRefusal }
