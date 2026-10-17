import { randomUUID } from 'node:crypto'

import { readAgentCommunicationCapabilities } from '../../shared/agent-communication-capabilities'
import type {
  PeerInboxBinding,
  PeerInboxAttempt,
  PeerInboxAdmission,
  PeerInboxPending,
  PeerInboxReceiverOwner,
  PeerInboxReceiverStatus
} from './peer-inbox-receiver-contracts'
export type {
  PeerInboxBinding,
  PeerInboxAttempt,
  PeerInboxAdmission,
  PeerInboxPending,
  PeerInboxReceiverOwner,
  PeerInboxReceiverStatus
} from './peer-inbox-receiver-contracts'

export function parsePeerInboxPending(value: unknown): PeerInboxPending {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid peer pending metadata')
  }
  const data = value as Record<string, unknown>
  const counts = ['pending', 'available', 'leased', 'blocked'] as const
  if (
    data.schema_version !== 1 ||
    counts.some((key) => !Number.isSafeInteger(data[key]) || (data[key] as number) < 0) ||
    data.pending !== (data.available as number) + (data.leased as number) + (data.blocked as number)
  ) {
    throw new Error('Invalid peer pending metadata')
  }
  return Object.freeze({
    schema_version: 1,
    pending: data.pending as number,
    available: data.available as number,
    leased: data.leased as number,
    blocked: data.blocked as number
  })
}

// One instance per immutable binding, owned by the existing exclusive input owner.
export class PeerInboxReceiver<B extends PeerInboxBinding> {
  private readonly binding: Readonly<B>
  private readonly key: string
  private readonly abort = new AbortController()
  private readonly interval: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private active = false
  private disposed = false
  private running = false
  private rerun = false
  private loaded = false
  private attempt: PeerInboxAttempt | null = null
  private notWritten: 'not-written' | undefined
  private attemptPhase: 'awaiting-completion' | 'uncertain' = 'uncertain'
  private failures = 0
  private retryAt = 0
  private lastPendingCheckAt: number | undefined
  private pending: PeerInboxPending | undefined
  private communication: PeerInboxReceiverStatus['communication']
  private status: PeerInboxReceiverStatus
  private readonly listeners = new Set<(status: PeerInboxReceiverStatus) => void>()

  constructor(
    binding: B,
    private readonly owner: PeerInboxReceiverOwner<B>,
    options: { pollIntervalMs?: number } = {}
  ) {
    if (!binding.key) {
      throw new Error('Peer binding key is required')
    }
    this.binding = Object.freeze(binding)
    this.key = binding.key
    this.interval = options.pollIntervalMs ?? 5_000
    if (!Number.isFinite(this.interval) || this.interval < 1) {
      throw new Error('Peer poll interval must be positive')
    }
    this.status = Object.freeze({ bindingKey: this.key, phase: 'stopped' })
  }

  getStatus(): PeerInboxReceiverStatus {
    if (this.active) {
      this.current()
    }
    return this.status
  }

  subscribe(listener: (status: PeerInboxReceiverStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (this.active || this.disposed) {
      return
    }
    this.active = true
    this.schedule(0)
  }

  notifyOwnerChanged(): void {
    if (!this.current()) {
      return
    }
    if (this.running) {
      this.rerun = true
    } else {
      this.schedule(0)
    }
  }

  dispose(): void {
    this.retire('stopped')
    this.listeners.clear()
  }

  private current(): boolean {
    if (!this.active || this.disposed) {
      return false
    }
    try {
      if (this.binding.key === this.key && this.owner.isCurrent(this.binding)) {
        return true
      }
    } catch {
      this.retire('error', 'binding-check-failed')
      return false
    }
    this.retire('revoked')
    return false
  }

  private retire(phase: 'stopped' | 'error' | 'revoked', reason?: string): void {
    this.disposed = true
    this.active = false
    this.abort.abort()
    if (this.timer !== null) {
      clearTimeout(this.timer)
    }
    this.timer = null
    this.publish(phase, reason)
  }

  private assertCurrent(): void {
    if (!this.current()) {
      throw new Error('Peer binding is no longer current')
    }
  }

  private hold(admission: Exclude<PeerInboxAdmission, 'ready'>): void {
    if (admission === 'revoked') {
      this.retire('revoked')
    } else {
      this.publish(admission)
    }
  }

  private publish(phase: PeerInboxReceiverStatus['phase'], reason?: string): void {
    this.status = Object.freeze({
      bindingKey: this.key,
      phase,
      pending: this.pending,
      communication: this.communication,
      attemptNonce: this.attempt?.nonce,
      reason,
      lastPendingCheckAt: this.lastPendingCheckAt,
      consecutiveFailures: this.failures,
      ...(this.active && this.retryAt > Date.now() ? { nextCheckAt: this.retryAt } : {})
    })
    for (const listener of this.listeners) {
      try {
        listener(this.status)
      } catch {
        // Status observers cannot interrupt durable admission.
      }
    }
  }

  private schedule(delay: number): void {
    if (!this.active) {
      return
    }
    if (this.timer !== null) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(
      () => {
        this.timer = null
        void this.tick()
      },
      Math.max(delay, this.retryAt - Date.now())
    )
    this.timer.unref?.()
  }

  private async clearAttempt(): Promise<void> {
    if (!this.attempt) {
      return
    }
    await this.owner.clearAttempt(this.binding, this.attempt.nonce, this.notWritten)
    this.assertCurrent()
    this.attempt = null
    this.notWritten = undefined
  }

  private async tick(): Promise<void> {
    if (this.running || !this.active) {
      return
    }
    this.running = true
    let stage = 'binding-check'
    let failed = false
    try {
      this.assertCurrent()
      if (!this.loaded) {
        stage = 'attempt-load'
        this.publish('loading')
        const restored = await this.owner.loadAttempt(this.binding)
        this.assertCurrent()
        if (restored !== null && (!restored.nonce || typeof restored.nonce !== 'string')) {
          throw new Error('Invalid attempt metadata')
        }
        this.attempt = restored ? Object.freeze(restored) : null
        this.loaded = true
      }
      if (this.attempt) {
        stage = 'attempt-observation'
        const outcome =
          this.notWritten ?? (await this.owner.observeAttempt(this.binding, this.attempt.nonce))
        this.assertCurrent()
        if (outcome !== 'completed' && outcome !== 'not-written') {
          this.publish(this.attemptPhase)
          return
        }
        this.notWritten = outcome === 'not-written' ? outcome : undefined
        stage = 'attempt-clear'
        await this.clearAttempt()
        this.assertCurrent()
      }
      stage = 'pending-read'
      this.publish('polling')
      const raw = await this.owner.readPending(this.abort.signal)
      this.assertCurrent()
      this.pending = parsePeerInboxPending(raw)
      this.communication = readAgentCommunicationCapabilities(raw)
      this.lastPendingCheckAt = Date.now()
      if (this.pending.available === 0) {
        this.publish('idle')
        return
      }
      stage = 'admission'
      const admission = await this.owner.admit(this.binding)
      this.assertCurrent()
      if (admission !== 'ready') {
        this.hold(admission)
        return
      }
      this.attempt = Object.freeze({ nonce: randomUUID() })
      this.notWritten = 'not-written'
      this.attemptPhase = 'uncertain'
      stage = 'attempt-persist'
      this.publish('persisting')
      await this.owner.persistAttempt(this.binding, this.attempt)
      this.assertCurrent()
      stage = 'admission'
      const finalAdmission = await this.owner.admit(this.binding)
      this.assertCurrent()
      if (finalAdmission !== 'ready') {
        stage = 'attempt-clear'
        await this.clearAttempt()
        this.assertCurrent()
        this.hold(finalAdmission)
        return
      }
      stage = 'hint-submit'
      this.publish('submitting')
      this.notWritten = undefined
      const result = await this.owner.submitHint(
        this.binding,
        this.attempt.nonce,
        this.abort.signal
      )
      this.assertCurrent()
      if (result === 'not-written') {
        this.notWritten = 'not-written'
        stage = 'attempt-clear'
        await this.clearAttempt()
        this.assertCurrent()
        this.publish('idle')
      } else {
        this.attemptPhase = result === 'submitted' ? 'awaiting-completion' : 'uncertain'
        this.publish(this.attemptPhase)
      }
    } catch {
      failed = true
      if (this.active) {
        this.failures = Math.min(this.failures + 1, 16)
        const ceiling = Math.min(60_000, this.interval * 2 ** this.failures)
        this.retryAt = Date.now() + Math.ceil(ceiling * (0.5 + Math.random() * 0.5))
        this.attemptPhase = 'uncertain'
        this.publish(this.attempt ? 'uncertain' : 'error', `${stage}-failed`)
      }
    } finally {
      this.running = false
      if (!failed && this.failures > 0) {
        this.failures = 0
        this.retryAt = 0
        this.publish(this.status.phase, this.status.reason)
      }
      if (this.active) {
        this.schedule(this.rerun ? 0 : this.interval)
      }
      this.rerun = false
    }
  }
}
