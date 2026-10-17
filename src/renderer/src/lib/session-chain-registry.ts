import { outcomeOwnerKey, type SessionOutcomeOwner } from './session-outcome-owner'
import { describeSessionChainStrip } from '@/components/next-step/next-step-summary'
import { useSyncExternalStore } from 'react'
import { upsertSessionChainOnHost } from '@/lib/session-chain-client'
import { LOCAL_CHAIN_TARGET, type SessionChainRowInfo } from '@/lib/session-chain-support'
import {
  isLiveSessionChain,
  isSessionChainAgentStep,
  isSessionFollowUpChain,
  type SessionChain
} from '../../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../../shared/session-outcome-state'
import { sessionChainDestination } from '../../../shared/session-chain-destination'
import { isQueuedSessionChain, preferredSessionChain } from './session-chain-row-choice'
import { sessionRunAsksThroughPane } from './session-run-panes'
import { setSessionRunRequestProbe } from './session-run-request-probe'

/**
 * The renderer's copy of every session chain this app session knows, with its run
 * controller. Queue chains feed the sidebar rows; saved follow-ups feed Waiting For.
 * The main state file stays authoritative: every change is written back over RPC.
 */
export type SessionChainEntry = { chain: SessionChain; controller: AbortController | null }

const chainsById = new Map<string, SessionChainEntry>()
// Why installed from here: the pane notification path must not import this registry.
setSessionRunRequestProbe((paneKey, now) =>
  sessionRunAsksThroughPane(
    [...chainsById.values()].map((entry) => entry.chain),
    paneKey,
    now
  )
)
const listeners = new Set<() => void>()
let rows: readonly SessionChainRowInfo[] = []
let followUps: readonly SessionChain[] = []
let shownChains: readonly SessionChain[] = []

/**
 * Live chains, plus failed ones: a failure stays on its row until the person dismisses it. An
 * outcome run is kept whatever its state, because its row, its Up next and its finish all read it.
 */
function isShownSessionChain(chain: SessionChain): boolean {
  return Boolean(chain.outcomeSet) || isLiveSessionChain(chain) || chain.state === 'failed'
}

export function publishSessionChains(): void {
  const chains = [...chainsById.values()].map((entry) => entry.chain)
  const now = Date.now()
  // Why: the row's queued mark and its cancel cover every chain after it, people-only ones too.
  rows = chains.filter(isShownSessionChain).map((chain) => ({
    chainId:
      chain.outcomeSet &&
      outcomeOwnerKey({ hostId: chain.placement ?? chain.hostId ?? 'local' }) !== 'local'
        ? chainRegistryKey(chain)
        : chain.id,
    ...(chain.outcomeSet ? { outcomeProgress: sessionOutcomeProgress(chain.outcomeSet) } : {}),
    summary: describeSessionChainStrip(chain).join(' → '),
    executionOwnerKey: chain.outcomeSet
      ? outcomeOwnerKey({ hostId: chain.placement ?? chain.hostId ?? 'local' })
      : undefined,
    rowKey: chain.sourceRowKey,
    queued: isQueuedSessionChain(chain, now)
      ? chain.steps.filter((step) => step.status === 'queued').length
      : 0,
    total: chain.steps.length,
    state: chain.state,
    auto: chain.auto,
    error: chain.error ?? null,
    destination: sessionChainDestination(chain),
    blocked: chain.blocked ?? null,
    launchedPaneKeys: chain.steps
      .filter(isSessionChainAgentStep)
      .map((step) => step.launchedPaneKey)
      .filter((paneKey): paneKey is string => typeof paneKey === 'string')
  }))
  followUps = chains.filter(isSessionFollowUpChain)
  shownChains = chains.filter(isShownSessionChain)
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeSessionChains(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getRows(): readonly SessionChainRowInfo[] {
  return rows
}

export function getSessionFollowUpChains(): readonly SessionChain[] {
  return followUps
}

export function useSessionChainRows(): readonly SessionChainRowInfo[] {
  return useSyncExternalStore(subscribeSessionChains, getRows, getRows)
}

function isLiveRow(row: SessionChainRowInfo): boolean {
  return (
    Boolean(row.outcomeProgress) ||
    row.state === 'waiting' ||
    row.state === 'ready' ||
    row.state === 'launching'
  )
}

/**
 * The live plan a session's next step is already chosen by: the plan queued after it, or the
 * plan that launched it. Anywhere ＋ would offer a next step, this puts 🔒 and where it goes.
 */
export function useSessionPlan(
  session: { rowKey: string; paneKey: string | null } | null
): SessionChainRowInfo | null {
  const all = useSyncExternalStore(subscribeSessionChains, getRows, getRows)
  if (!session) {
    return null
  }
  return (
    all.find((row) => isLiveRow(row) && row.rowKey === session.rowKey) ??
    all.find(
      (row) =>
        isLiveRow(row) &&
        session.paneKey !== null &&
        row.launchedPaneKeys.includes(session.paneKey) &&
        sameRowOwner(row, session.rowKey)
    ) ??
    null
  )
}

/** The live plan that launched this pane, when a plan did (not one queued after it). */
export function useLaunchedSessionPlan(
  paneKey: string | null,
  owner?: SessionOutcomeOwner
): SessionChainRowInfo | null {
  const all = useSyncExternalStore(subscribeSessionChains, getRows, getRows)
  if (!paneKey) {
    return null
  }
  const matches = all.filter(
    (row) =>
      isLiveRow(row) &&
      row.launchedPaneKeys.includes(paneKey) &&
      (!owner || !row.executionOwnerKey || row.executionOwnerKey === outcomeOwnerKey(owner))
  )
  return matches.length === 1 ? matches[0]! : null
}

function sameRowOwner(row: SessionChainRowInfo, rowKey: string): boolean {
  if (!row.executionOwnerKey) {
    return true
  }
  try {
    const hostId = JSON.parse(rowKey)[0] ?? 'local'
    return row.executionOwnerKey === outcomeOwnerKey({ hostId })
  } catch {
    return false
  }
}

export function useSessionFollowUpChains(): readonly SessionChain[] {
  return useSyncExternalStore(
    subscribeSessionChains,
    getSessionFollowUpChains,
    getSessionFollowUpChains
  )
}

/** Every chain queued after a row (agents, people or both): live, or failed and not yet dismissed. */
export function getShownChains(): readonly SessionChain[] {
  return shownChains
}

export function useShownSessionChains(): readonly SessionChain[] {
  return useSyncExternalStore(subscribeSessionChains, getShownChains, getShownChains)
}

export function useSessionChainForRow(rowKey: string | null): SessionChain | null {
  const chains = useSyncExternalStore(subscribeSessionChains, getShownChains, getShownChains)
  return rowKey
    ? preferredSessionChain(chains.filter((chain) => chain.sourceRowKey === rowKey))
    : null
}

export function getSessionChainEntry(
  chainId: string,
  owner?: SessionOutcomeOwner
): SessionChainEntry | null {
  const qualified = chainsById.get(chainId)
  if (qualified && (!owner || outcomeOwnerKey(qualified.chain) === outcomeOwnerKey(owner))) {
    return qualified
  }
  if (owner) {
    return chainsById.get(JSON.stringify([outcomeOwnerKey(owner), chainId])) ?? null
  }
  const matches = [...chainsById.values()].filter((entry) => entry.chain.id === chainId)
  return matches.length === 1 ? matches[0]! : null
}

export function getAllSessionChainEntries(): readonly SessionChainEntry[] {
  return [...chainsById.values()]
}

function chainRegistryKey(chain: SessionChain): string {
  return JSON.stringify([
    chain.outcomeSet
      ? outcomeOwnerKey({ hostId: chain.placement ?? chain.hostId ?? 'local' })
      : 'local',
    chain.id
  ])
}

export function setSessionChainEntry(chain: SessionChain): SessionChainEntry {
  const key = chainRegistryKey(chain)
  const existing = chainsById.get(key)
  if (existing) {
    if ((existing.chain.outcomeSet?.revision ?? 0) > (chain.outcomeSet?.revision ?? 0)) {
      return existing
    }
    existing.chain = chain
    return existing
  }
  const entry: SessionChainEntry = { chain, controller: null }
  chainsById.set(key, entry)
  return entry
}

export function deleteSessionChainEntry(chainId: string, owner?: SessionOutcomeOwner): void {
  const entry = getSessionChainEntry(chainId, owner)
  if (entry) {
    chainsById.delete(chainRegistryKey(entry.chain))
  }
}

export function clearSessionChainEntries(): void {
  for (const entry of chainsById.values()) {
    entry.controller?.abort()
  }
  chainsById.clear()
}

/** The live chain waiting on a sidebar row, agents or people alike; one chain per source row. */
export function findSessionChainForRow(rowKey: string): SessionChain | null {
  for (const { chain } of chainsById.values()) {
    if (chain.sourceRowKey === rowKey && isLiveSessionChain(chain)) {
      return chain
    }
  }
  return null
}

/** The chain a row shows: live, or failed and not yet dismissed. */
export function findShownSessionChainForRow(rowKey: string): SessionChain | null {
  return preferredSessionChain(
    [...chainsById.values()]
      .map((entry) => entry.chain)
      .filter((chain) => chain.sourceRowKey === rowKey && isShownSessionChain(chain))
  )
}

export function getSessionChain(chainId: string, owner?: SessionOutcomeOwner): SessionChain | null {
  return getSessionChainEntry(chainId, owner)?.chain ?? null
}

export function updateSessionChain(
  chainId: string,
  patch: Partial<SessionChain>
): SessionChain | null {
  const entry = getSessionChainEntry(chainId)
  if (!entry) {
    return null
  }
  if (entry.chain.outcomeSet) {
    throw new Error(
      'Edit the saved outcomes through their execution host. The committed set was preserved.'
    )
  }
  entry.chain = { ...entry.chain, ...patch, updatedAt: Date.now() }
  publishSessionChains()
  return entry.chain
}

export async function persistSessionChain(chain: SessionChain): Promise<void> {
  try {
    await upsertSessionChainOnHost(LOCAL_CHAIN_TARGET, chain)
  } catch (error) {
    console.error('[session-chain] failed to persist chain', error)
  }
}

/** Persist or throw: a follow-up records each effect before it happens. */
export async function persistSessionChainOrThrow(chain: SessionChain): Promise<void> {
  await upsertSessionChainOnHost(LOCAL_CHAIN_TARGET, chain)
}

/** The output folder of the chain step that launched a pane, when this app session knows it. */
export function findChainStepOutputForPane(
  paneKey: string
): { chainId: string; stepId: string; workspacePath: string } | null {
  for (const { chain } of chainsById.values()) {
    for (const step of chain.steps) {
      if (step.kind !== 'handoff' && step.launchedPaneKey === paneKey) {
        return { chainId: chain.id, stepId: step.id, workspacePath: chain.workspacePath }
      }
    }
  }
  return null
}
