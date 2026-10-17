import type { LedgerRegisterBody } from '../../shared/session-ledger-contract'
import type { LedgerPaneEntry, LedgerPaneRegistry } from './ledger-identity'
import {
  linkedCardForWorktree,
  type LedgerLinkedCard,
  type LinkedCardSource
} from './ledger-linked-card'

type Register = (entry: LedgerPaneEntry, body: LedgerRegisterBody) => void | Promise<void>

/** The card a row serves, or nulls to take it back out of one. */
export type LedgerCardLink = { cardId: string | null; cardTitle: string | null }

/** The store holding each workspace's explicit card link, and the feed that says one changed. */
export type LedgerWorkspaceLinks = {
  source: LinkedCardSource
  subscribeWorkspaceChanges: (listener: () => void) => () => void
}

/** Keeps each pane's card_id equal to its workspace's explicit link; a change on a live row is registered. */
export class LedgerCardLinks {
  constructor(
    private readonly register: Register,
    public resolver: ((worktreeId: string) => LedgerLinkedCard | null) | null
  ) {}

  /**
   * Read every workspace's explicit link from `links`, and re-read them whenever a workspace
   * changes so a link added while a pane is live reaches its row. Returns the unsubscribe.
   */
  attach(links: LedgerWorkspaceLinks, registry: LedgerPaneRegistry, retry: () => void): () => void {
    this.resolver = (worktreeId) => linkedCardForWorktree(links.source, worktreeId)
    return links.subscribeWorkspaceChanges(() => {
      retry()
      this.refreshAll(registry)
    })
  }

  /**
   * A person put this conversation in a task themselves. The link is recorded on the pane's
   * row (and registered) whatever the workspace says, and marked as theirs so a workspace
   * with no link of its own never takes it back off. False when no such pane is held here.
   */
  async linkPerson(
    registry: LedgerPaneRegistry,
    paneId: string,
    card: LedgerCardLink,
    account: string | null
  ): Promise<boolean> {
    const entry = registry.get(paneId) ?? registry.byLedgerId(paneId)
    if (!account || !entry || entry.account !== account) {
      return false
    }
    registry.update(entry.paneKey, {
      cardId: card.cardId,
      cardTitle: card.cardTitle,
      // An explicit removal must also survive resume and workspace refresh.
      cardLinkedBy: 'person'
    })
    await this.register(entry, { card_id: card.cardId, card_title: card.cardTitle })
    return registry.get(entry.paneKey) === entry
  }

  refreshAll(registry: LedgerPaneRegistry): void {
    for (const row of registry.localSessions()) {
      this.refresh(registry, row.paneId, true)
    }
  }

  refresh(registry: LedgerPaneRegistry, paneKey: string, registerIfChanged: boolean): void {
    const entry = registry.get(paneKey)
    if (!entry?.worktreeId || !this.resolver) {
      return
    }
    let card: LedgerLinkedCard | null = null
    try {
      card = this.resolver(entry.worktreeId)
    } catch {
      return
    }
    const cardId = card?.cardId ?? null
    const cardTitle = card?.cardTitle ?? null
    // Why: the workspace link wins whenever the workspace HAS one, but a workspace with no
    // link of its own says nothing about this conversation — it must not erase the task a
    // person put it in (`SessionLedgerService.linkCard`).
    if (cardId === null && entry.cardLinkedBy === 'person') {
      return
    }
    if (cardId === entry.cardId && cardTitle === entry.cardTitle) {
      return
    }
    registry.update(paneKey, {
      cardId,
      cardTitle,
      cardLinkedBy: cardId === null ? null : 'workspace'
    })
    if (registerIfChanged && entry.started && !entry.ended) {
      void this.register(entry, { card_id: cardId, card_title: cardTitle })
    }
  }
}
