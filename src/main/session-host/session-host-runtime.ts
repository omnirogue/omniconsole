/**
 * The paired runtime as a session host: its process holder, the `sessionHost.*` entry point for
 * another computer's paired connection, and what `runtime.status` advertises. The incarnation is the
 * runtime's own `runtimeId`, so a restart is visible to every client as a renegotiation.
 */

import { readClientSessionHostDeclaration } from '../../shared/session-host-capabilities'
import type { SessionHostIdentity } from '../../shared/session-host-identity'
import type { SessionHostMethod } from '../../shared/session-host-protocol'
import { sessionHostRefusal } from '../../shared/session-host-refusal'
import type { RpcContext } from '../runtime/rpc/core'
import { SessionHostProcess } from './session-host-process'
import { handleSessionHostRemoteCall } from './session-host-remote-gate'

let runtimeProcess: SessionHostProcess | null = null

export function runtimeSessionHostProcess(runtimeId: string): SessionHostProcess {
  runtimeProcess ??= new SessionHostProcess({ kind: 'paired-runtime', incarnation: runtimeId })
  return runtimeProcess
}

/** The holder startup created, or null (unit tests that never created one stay on the legacy path). */
export function activeRuntimeSessionHost(): SessionHostProcess | null {
  return runtimeProcess
}

/** Only this runtime's own holder, so an advertised incarnation always equals its `runtimeId`. */
export function runtimeSessionHostFor(runtimeId: string): SessionHostProcess | null {
  return runtimeProcess?.options.incarnation === runtimeId ? runtimeProcess : null
}

export function setRuntimeSessionHostProcessForTests(process: SessionHostProcess | null): void {
  runtimeProcess = process
}

/** For `getStatus()`: synchronous, and empty until an executor can carry something out. */
export function runtimeSessionHostStatus(
  runtimeId: string
): { capabilities: string[]; sessionHost: SessionHostIdentity } | null {
  const advertisement = runtimeSessionHostFor(runtimeId)?.advertisement()
  return advertisement
    ? { capabilities: advertisement.capabilities, sessionHost: advertisement.identity }
    : null
}

export const SESSION_HOST_REMOTE_ONLY =
  "Session host control is for another computer's OmniConsole over its paired connection; this computer's own UI and CLI use its session commands. Nothing was changed."

/**
 * Another computer only: a paired device, never the local socket (whose callers use the owner
 * service in process) and never a dispatched worker's capability.
 */
export async function handleRuntimeSessionHostCall(
  method: SessionHostMethod,
  params: unknown,
  ctx: Pick<
    RpcContext,
    'runtime' | 'pairedDeviceId' | 'clientCapabilities' | 'orchestrationCapability'
  >
): Promise<unknown> {
  if (!ctx.pairedDeviceId || ctx.orchestrationCapability) {
    return {
      status: 'refused',
      refusal: sessionHostRefusal('provenance-required', SESSION_HOST_REMOTE_ONLY)
    }
  }
  return await handleSessionHostRemoteCall(
    runtimeSessionHostProcess(ctx.runtime.getRuntimeId()),
    method,
    params,
    {
      transport: 'paired-runtime',
      peer: `paired:${ctx.pairedDeviceId}`,
      declared: readClientSessionHostDeclaration(
        ctx.clientCapabilities ? [...ctx.clientCapabilities] : undefined
      ),
      connection: null
    }
  )
}
