export type GetForegroundProcessRequest = {
  id: string
  type: 'getForegroundProcess'
  payload: {
    sessionId: string
  }
}

export type ConfirmForegroundProcessRequest = Omit<GetForegroundProcessRequest, 'type'> & {
  type: 'confirmForegroundProcess'
}

export type ConfirmShellForegroundRequest = Omit<GetForegroundProcessRequest, 'type'> & {
  type: 'confirmShellForeground'
}

export type InspectProcessRequest = Omit<GetForegroundProcessRequest, 'type'> & {
  type: 'inspectProcess'
}

/**
 * A write only while `receiver` holds the tty and, when fenced, `fenceToken` was never revoked
 * (`guarded-pty-write.ts`); answers `{ outcome }`. A daemon without it answers "Unknown request
 * type", which main treats as `unsupported`: nothing is written.
 */
export type FencedWriteRequest = {
  id: string
  type: 'fencedWrite'
  payload: {
    sessionId: string
    data: string
    receiver: { pid: number; pgid: number; startTimeMs: number }
    fenceToken?: string
  }
}

/** A conversation fence main revoked: every later fenced write under it is refused. */
export type RevokeWriteFenceRequest = {
  id: string
  type: 'revokeWriteFence'
  payload: { token: string }
}

/** Distinct discriminator: daemons implementing only asynchronous revocation must refuse. */
export type LatchedWriteRequest = Omit<FencedWriteRequest, 'type' | 'payload'> & {
  type: 'latchedWrite'
  payload: Omit<FencedWriteRequest['payload'], 'fenceToken'> & { latchToken: string }
}
