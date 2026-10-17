import type { RuntimeTerminalCreate } from '../../shared/runtime-types'

const DEFAULT_MAX_IN_FLIGHT_TERMINAL_CREATES = 4_096
const RECEIPT_TTL_MS = 10 * 60_000
const MAX_RECEIPTS = 1_024

export type TerminalCreateAttempt = {
  reconcileExisting: boolean
  onPtySpawnCommitted: () => void
  onProcessAbsent: () => void
}

type CreateTerminal = (
  freshIdentity?: boolean,
  attempt?: TerminalCreateAttempt
) => Promise<RuntimeTerminalCreate>

export class RemoteRuntimeTerminalCreateIdempotency {
  private readonly inFlight = new Map<string, Promise<RuntimeTerminalCreate>>()
  private readonly uncertain = new Map<
    string,
    { create: CreateTerminal; freshIdentity: boolean; fingerprint?: string }
  >()
  // Successful receipts only: at most 1024, retained for ten minutes after settlement.
  private readonly receipts = new Map<
    string,
    {
      fingerprint: string
      terminal: RuntimeTerminalCreate
      incarnationId?: string | null
      expiresAt: number
    }
  >()

  constructor(private readonly maxInFlight = DEFAULT_MAX_IN_FLIGHT_TERMINAL_CREATES) {}

  run(
    clientIdentity: string,
    worktreeId: string,
    clientMutationId: string,
    create: CreateTerminal,
    receipt?: {
      fingerprint: string
      getIncarnationId?: (terminal: RuntimeTerminalCreate) => string | null | undefined
      isAlive: (terminal: RuntimeTerminalCreate, incarnationId?: string | null) => boolean
    }
  ): Promise<RuntimeTerminalCreate> {
    const key = `${clientIdentity}\0${worktreeId}\0${clientMutationId}`
    const existing = this.inFlight.get(key)
    if (existing) {
      return existing
    }
    const uncertain = this.uncertain.get(key)
    if (uncertain && uncertain.fingerprint !== receipt?.fingerprint) {
      return Promise.reject(new Error('terminal_create_identity_conflict'))
    }
    for (const [id, settled] of this.receipts) {
      if (settled.expiresAt <= Date.now()) {
        this.receipts.delete(id)
      }
    }
    const settled = receipt ? this.receipts.get(key) : undefined
    const freshIdentity = settled !== undefined && settled.fingerprint !== receipt?.fingerprint
    if (settled && !uncertain) {
      if (!freshIdentity && receipt!.isAlive(settled.terminal, settled.incarnationId)) {
        return Promise.resolve(settled.terminal)
      }
      if (!freshIdentity) {
        this.receipts.delete(key)
      }
      if (freshIdentity) {
        console.warn('[terminal-create] Reused mutation id with a changed payload; creating anew')
      }
    }
    if (!uncertain && this.inFlight.size + this.uncertain.size >= this.maxInFlight) {
      return Promise.reject(
        new Error('Too many terminal creations are still pending; retry after they settle.')
      )
    }

    const attemptCreate = uncertain?.create ?? create
    const attemptFreshIdentity = uncertain?.freshIdentity ?? freshIdentity
    let retainFailure = uncertain !== undefined
    const attempt: TerminalCreateAttempt = {
      reconcileExisting: uncertain !== undefined,
      onPtySpawnCommitted: () => {
        retainFailure = true
      },
      onProcessAbsent: () => {
        retainFailure = false
      }
    }
    const promise = attemptCreate(attemptFreshIdentity || undefined, attempt)
    this.inFlight.set(key, promise)
    const drop = (): void => {
      if (this.inFlight.get(key) === promise) {
        this.inFlight.delete(key)
      }
    }
    void promise.then(
      (terminal) => {
        try {
          if (receipt || !uncertain) {
            this.uncertain.delete(key)
          }
          if (receipt) {
            this.receipts.delete(key)
            while (this.receipts.size >= MAX_RECEIPTS) {
              this.receipts.delete(this.receipts.keys().next().value!)
            }
            this.receipts.set(key, {
              fingerprint: receipt.fingerprint,
              terminal,
              incarnationId: receipt.getIncarnationId?.(terminal),
              expiresAt: Date.now() + RECEIPT_TTL_MS
            })
          }
        } catch {
          console.warn('[terminal-create] Could not retain the successful create receipt')
        } finally {
          drop()
        }
      },
      (error: unknown) => {
        if (
          retainFailure ||
          (error as { agentSessionOperationOutcome?: unknown } | null)
            ?.agentSessionOperationOutcome === 'unknown'
        ) {
          // A lost receipt cannot authorize another process; retry against the original host identity.
          this.uncertain.set(key, {
            create: attemptCreate,
            freshIdentity: attemptFreshIdentity,
            fingerprint: receipt?.fingerprint
          })
        } else {
          this.uncertain.delete(key)
        }
        drop()
      }
    )
    return promise
  }
}
