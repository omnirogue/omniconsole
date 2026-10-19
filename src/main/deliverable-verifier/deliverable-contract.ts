/**
 * One request's deliverables: what the person asked for (their words, a prepared prompt's Done when
 * list, a mission list) and what the reply says it produced, merged so each target is checked once.
 */

import { posix, win32 } from 'node:path'
import {
  DELIVERABLE_SOURCES,
  type DeliverableItem,
  type DeliverableSource
} from '../../shared/deliverable-verification-types'
import { sessionMissionFromPrompt } from '../../shared/session-mission'
import {
  extractDoneWhenOutputs,
  extractMissionOutputs,
  extractReplyClaims,
  extractRequestedOutputs,
  type ExtractedDeliverable
} from './deliverable-claims'

export const DELIVERABLE_CONTRACT_MAX_ITEMS = 20

export type DeliverablePathStyle = 'posix' | 'win32'

/** Where a workspace path lives: a drive letter or UNC path is Windows, anything else POSIX. */
export function deliverablePathStyle(workspacePath: string): DeliverablePathStyle {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(workspacePath) ? 'win32' : 'posix'
}

/**
 * The absolute path a target names on its host, or null when it cannot be told (a `~` path on a
 * host whose home this computer does not know). Relative paths resolve against the workspace.
 */
export function resolveDeliverablePath(
  target: string,
  workspacePath: string,
  style: DeliverablePathStyle,
  home: string | null
): string | null {
  const rules = style === 'win32' ? win32 : posix
  if (target === '~' || target.startsWith('~/') || target.startsWith('~\\')) {
    return home ? rules.join(home, target.slice(1)) : null
  }
  return rules.resolve(workspacePath, target)
}

/** The identity two spellings of one target share; macOS and Windows compare without case. */
export function deliverableTargetKey(
  item: Pick<DeliverableItem, 'target' | 'kind'>,
  resolved: string | null,
  caseInsensitive: boolean
): string {
  const raw = resolved ?? item.target
  const trimmed = item.kind === 'url' || item.kind === 'artifact' ? raw : raw.replace(/[\\/]+$/, '')
  return caseInsensitive ? trimmed.toLowerCase() : trimmed
}

type Sourced = ExtractedDeliverable & { source: DeliverableSource }

function tag(items: readonly ExtractedDeliverable[], source: DeliverableSource): Sourced[] {
  return items.map((item) => ({ ...item, source }))
}

/** The request side of a contract, from the person's prompt alone. */
export function requestDeliverables(prompt: string | undefined): DeliverableItem[] {
  if (!prompt?.trim()) {
    return []
  }
  const mission = sessionMissionFromPrompt(prompt)
  return [
    ...tag(extractRequestedOutputs(prompt), 'request'),
    ...tag(extractDoneWhenOutputs(prompt), 'prep'),
    ...tag(
      extractMissionOutputs(
        (mission?.deliverables ?? []).map((entry) => `${entry.title} ${entry.description}`)
      ),
      'mission'
    )
  ].map(({ declined: _declined, ...item }) => item)
}

export type DeliverableContractInput = {
  /** Items the request already named (from the prompt, or kept from the request a repair answers). */
  requested: readonly DeliverableItem[]
  reply: string
  workspacePath: string | null
  style: DeliverablePathStyle
  home: string | null
  caseInsensitive: boolean
}

export type DeliverableContractItem = DeliverableItem & { resolved: string | null }

/**
 * Merged and capped. A target keeps its highest-priority source; a reply's claim adds its verb, and
 * its decline, to whichever item names the same target.
 */
export function buildDeliverableContract(
  input: DeliverableContractInput
): DeliverableContractItem[] {
  const resolve = (item: Pick<DeliverableItem, 'target' | 'kind'>): string | null =>
    item.kind === 'url' || item.kind === 'artifact'
      ? null
      : input.workspacePath
        ? resolveDeliverablePath(item.target, input.workspacePath, input.style, input.home)
        : null
  const merged = new Map<string, DeliverableContractItem>()
  const all: DeliverableItem[] = [
    ...input.requested,
    ...tag(extractReplyClaims(input.reply), 'claim')
  ]
  const rank = (source: DeliverableSource): number => DELIVERABLE_SOURCES.indexOf(source)
  for (const item of all) {
    const resolved = resolve(item)
    const key = deliverableTargetKey(item, resolved, input.caseInsensitive)
    const known = merged.get(key)
    if (!known) {
      merged.set(key, { ...item, resolved })
      continue
    }
    const winner = rank(item.source) < rank(known.source) ? { ...item, resolved } : known
    const claim = item.source === 'claim' ? item.claim : known.claim
    const declined = item.declined ?? known.declined
    merged.set(key, { ...winner, claim, ...(declined ? { declined } : {}) })
  }
  return [...merged.values()].slice(0, DELIVERABLE_CONTRACT_MAX_ITEMS)
}
