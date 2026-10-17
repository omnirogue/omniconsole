import { isPtyIncarnationId } from './pty-incarnation'

export type PtyLaunchGateRequest = {
  version: 1
  launchId: string
  startupCommandMode?: 'exec'
  processObservation?: 'required'
}

export type PtyLaunchGateReceipt = {
  version: 1
  state: 'closed'
  launchId: string
  gateId: string
  ptyId: string
  incarnationId: string
  pid: number
  processStartTimeMs: number
  processKind: 'pty-root' | 'pty-shell'
  reportsChildExitStatus: boolean
  ptyRootPid?: number
  ptyRootProcessStartTimeMs?: number
  exitObserver?: 'macos-kqueue'
  /** exec means the registered process will be replaced by the configured launcher. */
  startupCommandMode: 'shell' | 'exec'
}

export type PtyLaunchGateRelease = {
  gate: PtyLaunchGateReceipt
  /** Reference to the canonical start acknowledgement already persisted by the caller. */
  startAcknowledgement: string
}

export type PtyLaunchGateReleased = {
  gateId: string
  state: 'released'
  startAcknowledgement: string
}

export type PtyLaunchGateObservation = {
  gateId: string
  ptyId: string
  incarnationId: string
  pid: number
  processStartTimeMs: number
  startAcknowledgement: string | null
} & (
  | { state: 'live'; source: 'macos-kqueue' }
  | { state: 'unverifiable'; reason: string }
  | {
      state: 'exited'
      source: 'macos-kqueue'
      waitStatus: number
      exitCode: number | null
      signal: number | null
      observedAtMs: number
    }
)

export function isPtyLaunchGateRequest(value: unknown): value is PtyLaunchGateRequest {
  const request = value as Partial<PtyLaunchGateRequest> | null
  return (
    request?.version === 1 &&
    isPtyIncarnationId(request.launchId) &&
    (request.startupCommandMode === undefined || request.startupCommandMode === 'exec') &&
    (request.processObservation === undefined ||
      (request.processObservation === 'required' && request.startupCommandMode === 'exec'))
  )
}

export function isPtyLaunchGateReceipt(value: unknown): value is PtyLaunchGateReceipt {
  const receipt = value as Partial<PtyLaunchGateReceipt> | null
  return (
    receipt?.version === 1 &&
    isPtyIncarnationId(receipt.launchId) &&
    receipt.state === 'closed' &&
    isPtyIncarnationId(receipt.gateId) &&
    typeof receipt.ptyId === 'string' &&
    receipt.ptyId.length > 0 &&
    isPtyIncarnationId(receipt.incarnationId) &&
    Number.isSafeInteger(receipt.pid) &&
    (receipt.pid as number) > 0 &&
    Number.isSafeInteger(receipt.processStartTimeMs) &&
    (receipt.processStartTimeMs as number) > 0 &&
    (receipt.processKind === 'pty-root' ||
      (receipt.processKind === 'pty-shell' &&
        Number.isSafeInteger(receipt.ptyRootPid) &&
        (receipt.ptyRootPid as number) > 0 &&
        receipt.ptyRootPid !== receipt.pid &&
        Number.isSafeInteger(receipt.ptyRootProcessStartTimeMs) &&
        (receipt.ptyRootProcessStartTimeMs as number) > 0 &&
        receipt.exitObserver === 'macos-kqueue' &&
        receipt.startupCommandMode === 'exec')) &&
    typeof receipt.reportsChildExitStatus === 'boolean' &&
    (receipt.startupCommandMode === 'shell' ||
      (receipt.startupCommandMode === 'exec' && receipt.reportsChildExitStatus === true))
  )
}
