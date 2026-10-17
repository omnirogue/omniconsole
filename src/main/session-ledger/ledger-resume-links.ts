import { normalizeAgentProviderSession } from '../../shared/agent-session-resume'
import type { LedgerTaskLink } from '../../shared/session-ledger-contract'
import type { LedgerCardLinks } from './ledger-card-links'
import type { LedgerPaneRegistry } from './ledger-identity'
import type { LedgerOwnerLedger } from './ledger-row-owner'

export type LedgerResumeSpawn = {
  paneKey: string
  ptyId: string
  worktreeId: string
  agent: string
  connectionId: string | null
  providerSession: unknown
}

/** A resumed pane gets its own row; only the exact conversation's task travels. */
export class LedgerResumeLinks {
  constructor(
    private readonly registry: LedgerPaneRegistry,
    private readonly owners: LedgerOwnerLedger,
    private readonly cards: LedgerCardLinks,
    private readonly principal: () => string | null
  ) {}

  read(paneKey: string): LedgerTaskLink | null {
    const account = this.principal()
    const entry = this.registry.get(paneKey)
    return account && entry?.account === account && entry.cardId
      ? { ledgerId: entry.ledgerId, cardId: entry.cardId, cardTitle: entry.cardTitle }
      : null
  }

  async carry(spawn: LedgerResumeSpawn): Promise<boolean> {
    const account = this.principal()
    const native = normalizeAgentProviderSession(spawn.providerSession)
    if (!account || !native) {
      return false
    }
    const sources = this.registry
      .panesForNativeSession(native.id)
      .filter(
        (entry) =>
          entry.paneKey !== spawn.paneKey &&
          entry.account === account &&
          entry.nativeSessionKey === native.key &&
          entry.agent === spawn.agent &&
          entry.worktreeId === spawn.worktreeId &&
          entry.connectionId === spawn.connectionId &&
          entry.remote === (spawn.connectionId !== null) &&
          entry.cardLinkedBy === 'person'
      )
    const source = sources[0]
    // Conflicting explicit links cannot be resolved by picking the oldest or newest pane.
    if (!source?.cardId || sources.some((entry) => entry.cardId !== source.cardId)) {
      return false
    }
    let target = this.registry.get(spawn.paneKey)
    if (
      target &&
      (target.cardLinkedBy !== null ||
        target.cardId !== null ||
        (target.account !== null && target.account !== account) ||
        (target.ptyId !== null && target.ptyId !== spawn.ptyId) ||
        (target.agent !== null && target.agent !== spawn.agent) ||
        (target.nativeSessionId !== null && target.nativeSessionId !== native.id) ||
        (target.nativeSessionKey != null && target.nativeSessionKey !== native.key) ||
        (target.worktreeId !== null && target.worktreeId !== spawn.worktreeId) ||
        (target.connectionId !== undefined && target.connectionId !== spawn.connectionId))
    ) {
      return false
    }
    if (!target) {
      target = this.registry.stamp(spawn.paneKey, {
        ptyId: spawn.ptyId,
        worktreeId: spawn.worktreeId
      }).entry
      this.owners.stamped(target.paneKey)
    }
    if (target.account === null && !this.owners.claim(this.registry, target.ledgerId, account)) {
      return false
    }
    this.registry.update(target.paneKey, {
      ptyId: spawn.ptyId,
      agent: spawn.agent,
      worktreeId: spawn.worktreeId,
      nativeSessionId: native.id,
      nativeSessionKey: native.key,
      connectionId: spawn.connectionId,
      remote: spawn.connectionId !== null
    })
    const linked = await this.cards.linkPerson(
      this.registry,
      target.paneKey,
      {
        cardId: source.cardId,
        cardTitle: source.cardTitle
      },
      account
    )
    if (linked && this.principal() === account && this.registry.get(target.paneKey) === target) {
      this.registry.update(target.paneKey, { cardId: target.cardId })
    }
    return linked && this.principal() === account
  }
}
