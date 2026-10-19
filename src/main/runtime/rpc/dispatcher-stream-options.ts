import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { TerminalStreamFrame } from '../../../shared/terminal-stream-protocol'
import type { PairingRpcContext } from './core'
import type { SessionManageUnattended } from '../../../shared/session-manage-types'

export type RpcDispatchStreamingOptions = {
  authenticatedCallerFingerprint?: string
  connectionId?: string
  signal?: AbortSignal
  /** Unix-socket dispatch: arms the socket keepalive for a request that turns out to wait. */
  keepAliveWhileWaiting?: () => void
  clientId?: string
  pairedDeviceId?: string
  clientKind?: 'mobile' | 'runtime'
  clientCapabilities?: readonly RuntimeCapability[]
  pairing?: PairingRpcContext
  /** Socket admission only: the caller is bound to an automatic cleanup run. */
  unattendedCaller?: SessionManageUnattended
  /** Socket admission only: the local CLI's own pid, for process-tree checks. */
  callerPid?: number
  sendBinary?: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
  registerBinaryStreamHandler?: (
    streamId: number,
    handler: (frame: TerminalStreamFrame) => void
  ) => () => void
  registerBinaryMessageHandler?: (
    handler: (bytes: Uint8Array<ArrayBufferLike>) => void
  ) => () => void
}
