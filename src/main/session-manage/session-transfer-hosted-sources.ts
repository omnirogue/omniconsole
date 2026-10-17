/**
 * The part of a handoff or consolidation whose sources run under a session host: validated with
 * the rest, reserved at their hosts in canonical host/conversation order, asked for briefs there,
 * rechecked before the target gets anything, and settled there once the target accepted (or
 * released when it did not). With no hosted sources every step is a no-op, so a transfer between
 * this computer's own sessions behaves exactly as before.
 */

import type {
  SessionTransferHostSourceReceipt,
  SessionTransferIdentity,
  SessionTransferResult
} from '../../shared/session-transfer-types'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { SessionManageRefusal } from './session-manage-refusal'
import type {
  SessionTransferInput,
  SessionTransferMode,
  TransferSession
} from './session-manage-transfer-contract'
import type { TransferBriefSource } from './session-transfer-brief'
import {
  canonicalHostOrder,
  HostTransferSources,
  type HostTransferDeps,
  type HostTransferSource
} from './session-transfer-host-sources'

/** What a transfer needs to use hosted sources; absent on a computer without session hosts. */
export type SessionTransferHostedDeps = HostTransferDeps & {
  /** A source of this computer's own that its session host has adopted, reached through it. */
  hostedFor?(session: TransferSession): Promise<HostTransferSource | null>
  /** This computer's session host id: the target runs here. */
  targetHostId(): Promise<string>
  /** The target's conversation id as this computer's host knows (or would name) it. */
  targetConversationId(target: TransferSession): Promise<string>
}

/** Its title, and the computer it runs on when that is not this one. */
function named(source: HostTransferSource): string {
  return source.local ? source.title : `${source.title} (on ${source.port.label})`
}

/**
 * This computer's own sources that its session host adopted move to the hosted path, so they are
 * reserved and settled at their host like any other; a move to another computer keeps them local.
 */
export async function routeHostedTransferSources(
  deps: SessionTransferHostedDeps | undefined,
  input: SessionTransferInput
): Promise<SessionTransferInput> {
  if (!deps?.hostedFor || input.host) {
    return input
  }
  const sources: TransferSession[] = []
  const hostSources = [...(input.hostSources ?? [])]
  for (const session of input.sources) {
    const hosted = await deps.hostedFor(session).catch(() => null)
    if (hosted) {
      hostSources.push({ ...hosted, local: session })
    } else {
      sources.push(session)
    }
  }
  return sources.length === input.sources.length ? input : { ...input, sources, hostSources }
}

export class HostedTransferSources {
  private hosts: HostTransferSources | null = null
  private sources: HostTransferSource[]
  private acknowledged = false

  constructor(
    private readonly deps: SessionTransferHostedDeps | undefined,
    input: SessionTransferInput,
    private readonly mode: SessionTransferMode
  ) {
    this.sources = [...(input.hostSources ?? [])].sort((a, b) =>
      canonicalHostOrder(
        { hostId: a.port.hostId, conversationId: a.conversationId },
        { hostId: b.port.hostId, conversationId: b.conversationId }
      )
    )
  }

  get count(): number {
    return this.sources.length
  }

  get transfer(): string | undefined {
    return this.hosts?.transfer
  }

  /** Before anything is asked: what hosted sources cannot be combined with. */
  validate(input: SessionTransferInput, legacy: number): void {
    if (this.sources.length === 0) {
      return
    }
    if (!this.deps) {
      throw new SessionManageRefusal(
        'This computer cannot reach sessions on other computers. Nothing was changed.'
      )
    }
    const keys = this.sources.map((source) => `${source.port.hostId}\u0000${source.conversationId}`)
    if (new Set(keys).size !== keys.length) {
      throw new Error('Sources must be distinct conversations.')
    }
    if (input.host) {
      throw new SessionManageRefusal(
        '--host moves only sources on this computer; a source on another computer is handed off from there. Nothing was changed.'
      )
    }
    if (input.target === 'new' && legacy === 0 && !this.template()) {
      throw new SessionManageRefusal(
        'A new target starts from a source on this computer; with every source on another computer, name an existing target here. Nothing was changed.'
      )
    }
    const template = legacy === 0 ? this.template() : undefined
    if (input.target === 'new' && template && !isTuiAgent(template.entry.agent)) {
      throw new Error(`Cannot launch agent kind ${template.entry.agent}.`)
    }
  }

  /** Hosted sources that run on this computer, as its panes show them (for adoption). */
  localSessions(): TransferSession[] {
    return this.sources.flatMap((source) => (source.local ? [source.local] : []))
  }

  /** A source of this computer's own: what a new target copies its workspace and folder from. */
  template(): TransferSession | undefined {
    return this.sources.find((source) => source.local)?.local
  }

  briefSources(): TransferBriefSource[] {
    return this.sources.map((source) => ({ entry: { title: named(source) } }))
  }

  identities(): SessionTransferIdentity[] {
    return this.sources.map((source) => ({
      paneKey: source.local?.entry.paneKey ?? null,
      title: named(source)
    }))
  }

  steps(): string[] {
    const asked = this.mode === 'handoff' ? 'a handoff brief' : 'a short summary'
    return this.sources.map(
      (source) =>
        `Reserve “${source.title}” at its session host on ${source.port.label} and ask it there for ${asked}; it stays reserved until the target accepts, then its host archives it (never deletes it).`
    )
  }

  /** In canonical order; consolidate with skip-busy reports a refused source and goes on. */
  async reserve(
    input: SessionTransferInput,
    target: TransferSession | 'new',
    skipped: SessionTransferResult['skipped']
  ): Promise<void> {
    if (this.sources.length === 0) {
      return
    }
    const deps = this.deps!
    this.hosts = await HostTransferSources.start(
      deps,
      this.mode,
      {
        hostId: await deps.targetHostId(),
        ...(target === 'new' ? {} : { conversationId: await deps.targetConversationId(target) })
      },
      this.sources
    )
    const kept: HostTransferSource[] = []
    for (const source of this.sources) {
      try {
        await this.hosts.reserve(source.conversationId)
        kept.push(source)
      } catch (error) {
        if (
          this.mode !== 'consolidate' ||
          !input.skipBusy ||
          !(error instanceof SessionManageRefusal)
        ) {
          throw error
        }
        skipped.push({
          paneKey: source.local?.entry.paneKey ?? null,
          title: named(source),
          reason: error.message
        })
      }
    }
    this.sources = kept
  }

  async briefs(onAsk: (title: string) => void): Promise<string[]> {
    const briefs: string[] = []
    for (const source of this.sources) {
      onAsk(named(source))
      briefs.push(await this.hosts!.brief(source.conversationId))
    }
    return briefs
  }

  async recheck(): Promise<void> {
    await this.hosts?.recheck()
  }

  /** How the result names a settled source: this computer's pane, or its title and computer. */
  identityOf(receipt: SessionTransferHostSourceReceipt): SessionTransferIdentity {
    const source = this.sources.find(
      (one) => one.port.hostId === receipt.hostId && one.conversationId === receipt.conversationId
    )
    return source
      ? { paneKey: source.local?.entry.paneKey ?? null, title: named(source) }
      : { paneKey: null, title: `${receipt.title} (on ${receipt.label})` }
  }

  markAcknowledged(): void {
    this.acknowledged = true
  }

  /** Settles every hosted source and adds its receipts to the result. */
  async settleInto(result: SessionTransferResult, target: TransferSession | 'new'): Promise<void> {
    const receipts = await this.settle(target)
    if (receipts.length > 0) {
      noteHostedReceipts(result, receipts, this.transfer, (receipt) => this.identityOf(receipt))
    }
  }

  /**
   * Settles every hosted source whatever happened to the rest: archived at its host once the target
   * accepted, released otherwise. Never throws: a host that cannot be reached is `unresolved`.
   */
  async settle(target: TransferSession | 'new'): Promise<SessionTransferHostSourceReceipt[]> {
    if (!this.hosts) {
      return []
    }
    try {
      if (!this.acknowledged || target === 'new') {
        return await this.hosts.settle('abandoned')
      }
      return await this.hosts.settle('accepted', {
        hostId: this.hosts.record.target.hostId,
        conversationId: await this.deps!.targetConversationId(target),
        operationId: this.hosts.transfer
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return this.hosts.record.sources.map((entry) => ({
        hostId: entry.hostId,
        label: entry.label,
        conversationId: entry.conversationId,
        title: entry.title,
        state: entry.receipt?.state ?? 'unresolved',
        detail: entry.receipt?.detail ?? detail
      }))
    }
  }
}

/** Adds each hosted source's receipt to the result: archived ones, and a line per host's answer. */
export function noteHostedReceipts(
  result: SessionTransferResult,
  receipts: readonly SessionTransferHostSourceReceipt[],
  transfer: string | undefined,
  identify: (receipt: SessionTransferHostSourceReceipt) => SessionTransferIdentity
): void {
  result.hostSources = [...receipts]
  if (transfer) {
    result.transfer = transfer
  }
  result.archived.push(...receipts.filter((receipt) => receipt.state === 'archived').map(identify))
  result.summary = [result.summary, hostedReceiptsSummary(receipts, transfer)]
    .filter(Boolean)
    .join(' ')
}

/** One line for the summary: what each hosted source's host did with it. */
export function hostedReceiptsSummary(
  receipts: readonly SessionTransferHostSourceReceipt[],
  transfer?: string
): string {
  if (receipts.length === 0) {
    return ''
  }
  const words: Record<SessionTransferHostSourceReceipt['state'], string> = {
    archived: 'archived there',
    kept: 'kept there, unarchived',
    released: 'released there, unchanged',
    unresolved: 'unresolved (its computer did not answer; it may still be reserved there)'
  }
  const lines = receipts.map(
    (receipt) => `“${receipt.title}” on ${receipt.label}: ${words[receipt.state]}.`
  )
  const more =
    receipts.some((receipt) => receipt.state === 'unresolved') && transfer
      ? ` Continue transfer ${transfer} to settle what is unresolved; no brief is asked again.`
      : ''
  return `${lines.join(' ')}${more}`
}
