import type { LedgerRegisterBody } from '../../shared/session-ledger-contract'
import type { SessionLedgerClient } from './ledger-client'
import type { LedgerPaneEntry } from './ledger-identity'

const HELD_REGISTERS_MAX = 200

type HeldRegister = {
  ledgerId: string
  account: string | null
  body: LedgerRegisterBody
  rejections: number
}

/** A console 4xx is retried this many times before the body is given up, loudly. */
export const LEDGER_REGISTER_REJECTED_MAX_ATTEMPTS = 3

function heldKey(ledgerId: string, account: string | null): string {
  return `${ledgerId}\0${account ?? ''}`
}

/**
 * `register` enrichment bound to the account a row was opened under. A register whose
 * account is not the signed-in person is held (merged per row) and retried once it is. One
 * for a row still without an owner (opened before sign-in resolved) is held until the row
 * is claimed by the principal that resolves (contract §0b.11) — never dropped, never sent
 * under anyone else.
 */
export class LedgerRegisterBinding {
  private readonly held = new Map<string, HeldRegister>()

  constructor(
    private readonly client: Pick<SessionLedgerClient, 'register'>,
    private readonly currentPrincipal: () => string | null,
    /** Whether the row `ledgerId` is bound to `account` (read-only; a row without an owner is nobody's). */
    private readonly claimOwner: (ledgerId: string, account: string) => boolean = () => false,
    private readonly warn: (message: string) => void = () => {}
  ) {}

  send(
    entry: Pick<LedgerPaneEntry, 'ledgerId' | 'account'>,
    body: LedgerRegisterBody
  ): Promise<void> {
    this.hold(entry.ledgerId, entry.account, body)
    return this.retry()
  }

  /** Deliver whatever is held for the signed-in account; anything else keeps waiting. */
  async retry(): Promise<void> {
    const current = this.currentPrincipal()
    if (!current) {
      return
    }
    // Why a snapshot: a mismatch re-holds the row while this loop is still running.
    for (const [key, held] of Array.from(this.held)) {
      // Why: an ownerless body goes out only if the row itself turns out to be this person's;
      // it is never adopted by whoever signs in next.
      const account = held.account ?? (this.claim(held.ledgerId, current) ? current : null)
      if (account !== current) {
        continue
      }
      this.held.delete(key)
      const result = await this.client.register(held.ledgerId, held.body, account)
      if (result.ok) {
        continue
      }
      const rejections = held.rejections + (result.reason === 'rejected' ? 1 : 0)
      if (rejections >= LEDGER_REGISTER_REJECTED_MAX_ATTEMPTS) {
        this.warn(
          `register rejected by the console ${rejections} times; giving up (${held.ledgerId})`
        )
        continue
      }
      // Why: the person changed mid-flight, the token lapsed or the console was unreachable;
      // the body stays bound to its account and goes out once that person is signed in.
      this.hold(held.ledgerId, account, held.body, rejections)
    }
  }

  heldCount(): number {
    return this.held.size
  }

  private claim(ledgerId: string, account: string): boolean {
    try {
      return this.claimOwner(ledgerId, account)
    } catch {
      return false
    }
  }

  private hold(
    ledgerId: string,
    account: string | null,
    body: LedgerRegisterBody,
    rejections = 0
  ): void {
    // Why: held bodies merge per row AND binding; an ownerless one never folds into an owner's.
    const key = heldKey(ledgerId, account)
    const existing = this.held.get(key)
    const merged: HeldRegister = {
      ledgerId,
      account,
      body: existing ? { ...existing.body, ...body } : body,
      rejections: Math.max(rejections, existing?.rejections ?? 0)
    }
    this.held.delete(key)
    this.held.set(key, merged)
    while (this.held.size > HELD_REGISTERS_MAX) {
      const oldest = this.held.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.held.delete(oldest)
    }
  }
}
