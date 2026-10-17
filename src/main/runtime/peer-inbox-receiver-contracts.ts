import type { AgentCommunicationCapabilities } from '../../shared/agent-communication-capabilities'

export type PeerInboxBinding = { readonly key: string }
export type PeerInboxAttempt = { readonly nonce: string }
export type PeerInboxAdmission = 'ready' | 'busy' | 'consent' | 'input' | 'revoked'
export type PeerInboxPending = {
  readonly schema_version: 1
  readonly pending: number
  readonly available: number
  readonly leased: number
  readonly blocked: number
}

export type PeerInboxReceiverOwner<B extends PeerInboxBinding> = {
  isCurrent(binding: Readonly<B>): boolean
  readPending(signal: AbortSignal): Promise<unknown>
  admit(binding: Readonly<B>): PeerInboxAdmission | Promise<PeerInboxAdmission>
  loadAttempt(binding: Readonly<B>): Promise<PeerInboxAttempt | null>
  persistAttempt(binding: Readonly<B>, attempt: PeerInboxAttempt): Promise<void>
  clearAttempt(binding: Readonly<B>, nonce: string, evidence?: 'not-written'): Promise<void>
  // The exclusive input owner must recheck admission immediately before any write.
  submitHint(
    binding: Readonly<B>,
    nonce: string,
    signal: AbortSignal
  ): Promise<'submitted' | 'not-written' | 'uncertain'>
  // Completion requires native evidence for this nonce; idle alone is insufficient.
  observeAttempt(
    binding: Readonly<B>,
    nonce: string
  ): Promise<'unresolved' | 'completed' | 'not-written'>
}

export type PeerInboxReceiverStatus = {
  readonly bindingKey: string
  readonly phase:
    | 'stopped'
    | 'loading'
    | 'polling'
    | 'idle'
    | Exclude<PeerInboxAdmission, 'ready'>
    | 'persisting'
    | 'submitting'
    | 'awaiting-completion'
    | 'uncertain'
    | 'error'
  readonly pending?: PeerInboxPending
  // Read-only: what the hub's code advertises for agent exchange. It never gates this receiver.
  readonly communication?: AgentCommunicationCapabilities
  readonly attemptNonce?: string
  readonly reason?: string
  readonly lastPendingCheckAt?: number
  readonly consecutiveFailures?: number
  readonly nextCheckAt?: number
}
