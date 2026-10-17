/**
 * The session another one waits on, read on this host: where it runs, and whether it holds a
 * result — a Tier 1 seal (`sessionCommitmentProof`, its recorded commitment proven whole) or a
 * Tier 2 result card the steward saved when it found the session finished. The revision names
 * WHICH result, so a waiter's receipt is bound to the result it picked up.
 */

import { createHash } from 'node:crypto'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { SessionChain } from '../../shared/session-chain-types'
import { sessionCommitmentProof } from '../../shared/session-archive-proof'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { isFinishedOutcomeChain } from '../runtime/session-outcome-source-uniqueness'

type Runtime = Pick<
  OrcaRuntimeService,
  'listSessionChains' | 'resolveTerminalPane' | 'getLastAgentHookRowForPane'
>

export type AwaitedSessionLocation =
  | { kind: 'local' }
  /** Runs on an SSH host or another OmniConsole: nothing here can vouch for its result. */
  | { kind: 'remote'; where: string }
  /** No pane, chat or plan of that key on this computer. */
  | { kind: 'missing' }

export type AwaitedSessionResult = {
  tier: 'seal' | 'card'
  /** Which result: the seal's completion identity or the card's own revision, hashed short. */
  revision: string
  at?: number
  /** The awaited session's own closing words, when this host holds them. */
  excerpt?: string
}

/** What a Tier 2 result card says about a pane (the steward's card store registers this). */
export type SessionResultCardReading = { revision: string; at?: number; summary?: string }
type ResultCardReader = (paneKey: string) => SessionResultCardReading | null

let readResultCard: ResultCardReader | null = null

/** WP-S2 registers its card store; until then only a Tier 1 seal is a result. Returns undo. */
export function installSessionResultCardReader(reader: ResultCardReader | null): () => void {
  const previous = readResultCard
  readResultCard = reader
  return () => {
    readResultCard = previous
  }
}

function remoteWhere(hostId: string | null | undefined): string | null {
  const host = parseExecutionHostId(hostId)
  if (!host || host.kind === 'local') {
    return null
  }
  return host.kind === 'ssh' ? `the SSH host ${host.targetId}` : 'another OmniConsole'
}

function chatHolds(paneKey: string): boolean {
  return (getStructuredAgentSessionHost()?.listSessionTabs() ?? []).some(
    (session) =>
      structuredAgentSessionPaneKey(
        structuredAgentSessionTabId(session.sessionId),
        session.sessionId
      ) === paneKey
  )
}

function plansOf(runtime: Runtime, paneKey: string): SessionChain[] {
  return runtime.listSessionChains().filter((chain) => chain.sourcePaneKey === paneKey)
}

export function locateAwaitedSession(runtime: Runtime, paneKey: string): AwaitedSessionLocation {
  if (chatHolds(paneKey)) {
    return { kind: 'local' }
  }
  try {
    const pane = runtime.resolveTerminalPane(paneKey)
    const where = remoteWhere(pane.executionHostId)
    return where ? { kind: 'remote', where } : { kind: 'local' }
  } catch {
    // Its tab is closed; a plan it filed still says where it ran.
  }
  const plan = plansOf(runtime, paneKey).at(-1)
  if (!plan) {
    return { kind: 'missing' }
  }
  const where = remoteWhere(plan.placement ?? plan.hostId)
  return where ? { kind: 'remote', where } : { kind: 'local' }
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function clip(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim()
  return text ? (text.length > 400 ? `${text.slice(0, 399)}…` : text) : undefined
}

/**
 * The awaited session's result, or null while it has none. A plan still open on it means it is
 * not done, whatever an older plan of its sealed; `since` (epoch ms) ignores results before it.
 */
export function readAwaitedSessionResult(
  runtime: Runtime,
  paneKey: string,
  since?: number
): AwaitedSessionResult | null {
  const plans = plansOf(runtime, paneKey).filter((chain) => chain.outcomeSet && !chain.quarantine)
  if (plans.some((chain) => !isFinishedOutcomeChain(chain))) {
    return null
  }
  const excerpt = clip(runtime.getLastAgentHookRowForPane(paneKey)?.lastAssistantMessage)
  const sealed = plans
    .map((chain) => ({ chain, proof: sessionCommitmentProof(chain) }))
    .filter(
      (entry): entry is { chain: SessionChain; proof: string } =>
        entry.proof !== null &&
        (since === undefined || (entry.chain.outcomeSet?.completion?.at ?? 0) > since)
    )
    .toSorted((left, right) => right.chain.updatedAt - left.chain.updatedAt)[0]
  if (sealed) {
    const at = sealed.chain.outcomeSet?.completion?.at
    return {
      tier: 'seal',
      revision: `seal-${shortHash(sealed.proof)}`,
      ...(at !== undefined ? { at } : {}),
      ...(excerpt ? { excerpt } : {})
    }
  }
  let card: SessionResultCardReading | null = null
  try {
    card = readResultCard?.(paneKey) ?? null
  } catch {
    card = null
  }
  if (!card || (since !== undefined && card.at !== undefined && card.at <= since)) {
    return null
  }
  const words = clip(card.summary) ?? excerpt
  return {
    tier: 'card',
    revision: `card-${shortHash(card.revision)}`,
    ...(card.at !== undefined ? { at: card.at } : {}),
    ...(words ? { excerpt: words } : {})
  }
}
