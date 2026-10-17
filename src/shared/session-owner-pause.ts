export const SESSION_OWNER_PAUSE_RPC = 'sessionOwner.pause'

/** Coordinates belong to the selected execution runtime, not its client's mirrored tabs. */
export type SessionOwnerPauseParams = {
  expectedExecutionRuntimeId: string
  target:
    | {
        kind: 'terminal'
        hostId: string
        worktreeId: string
        paneKey: string
        tabId?: string
        agent: string
        providerSessionId: string
        terminalHandle: string
        ptyId: string
        workingStartedAt?: number
        prompt?: string
      }
    | {
        kind: 'structured'
        hostId: 'local'
        worktreeId: string
        sessionId: string
        turnId: string | null
        runtimeFence: number
      }
}

export type SessionOwnerPauseResult = {
  state: 'paused' | 'already-idle' | 'source-changed' | 'unverifiable'
  message: string
  keepGoingStopped?: boolean
  queuedPrompts?: number
}
