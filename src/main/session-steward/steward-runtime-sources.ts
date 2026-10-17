import { upNextView } from '../runtime/up-next'
import { getNextStepSuggestionService } from '../next-steps/next-step-suggestion-slot'
import { createArchiveReview } from './steward-archive-review'
/**
 * The real readings behind the steward's pass and its Tier 2 check: this runtime's sidebar (read
 * once per pass and shared for a few seconds with the archive re-check), observations, chains,
 * the organization history, git, the linked-docs store and JEV. Nothing here acts.
 */

import { createHash } from 'node:crypto'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import { normalizeNextStepSuggestionSettings } from '../../shared/next-step-suggestion-settings'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { promptQueuePending } from '../../shared/prompt-queue-types'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import { sessionLinksInText } from '../../shared/session-links'
import { getSessionLinkedDocsStore } from '../artifacts/session-linked-docs-store'
import { readSessionPullRequestFacts } from '../github/session-pull-request-facts'
import { getNextStepJev } from '../next-steps/next-step-jev-slot'
import type { Store } from '../persistence'
import {
  addressesConversation,
  isChainBoundToConversation
} from '../runtime/conversation-chain-ownership'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { stewardMutationGeneration } from './steward-mutation-generation'
import { observeSession, sessionManageSource } from '../session-manage/session-manage-observe'
import {
  readSidebarRows,
  runtimeReadChangedFiles
} from '../session-manage/session-manage-runtime-actions'
import {
  createRuntimeObserveSources,
  isKeepGoingOn,
  readRuntimeLatestTurn,
  readRuntimeOwnSteps,
  runtimeNeverReplied,
  snapshotRuntimeLatestTurn
} from '../session-manage/session-manage-runtime-sources'
import type { SessionManageEntryAnnotator } from '../session-manage/session-manage-inventory'
import type { OrganizationChangeLedger } from '../session-organization/organization-change-ledger'
import type { SessionPendingDeliveries } from '../session-manage/session-pending-deliveries'
import { isSessionPendingDeliverySettled } from '../../shared/session-pending-delivery-types'
import { createStewardJev, type StewardJev } from './steward-jev'
import type { StewardPassDeps } from './steward-pass'
import { stewardStalledHolds } from './steward-rules'
import type { StewardStateStore } from './steward-state-store'
import type { StewardTier2Deps } from './steward-tier2-check'
import type { FreshPaneEvidence } from '../agent-hooks/fresh-pane-evidence'
import { runtimePersonPrompted } from './steward-prompted-runtime'
import { stalledWaitersFromChains, type StewardStalledWaiter } from './steward-stalled-waiters'
import { sessionWaitersOf } from './steward-waiter-source'

const ROWS_SHARED_MS = 3_000
const PULL_REQUEST_FACTS = 3
const PULL_REQUEST_TIMEOUT_MS = 4_000

/** A prompt held for a busy session (#751's `--when-idle`); none until that host registers it. */
let heldDeliveries: ((paneKey: string) => boolean) | null = null

/** Returns the restore. */
export function setStewardHeldDeliverySource(
  next: ((paneKey: string) => boolean) | null
): () => void {
  const previous = heldDeliveries
  heldDeliveries = next
  return () => {
    heldDeliveries = previous
  }
}

/** #751's held prompts: one waiting or being sent to this pane holds it for its sender. */
export function pendingDeliveryHolds(
  deliveries: Pick<SessionPendingDeliveries, 'list'> | null,
  paneKey: string
): boolean {
  return (
    deliveries
      ?.list()
      .some(
        (delivery) =>
          delivery.target.paneKey === paneKey && !isSessionPendingDeliverySettled(delivery)
      ) ?? false
  )
}

function isHeld(paneKey: string): boolean {
  try {
    return heldDeliveries?.(paneKey) ?? false
  } catch {
    // Why held: an unreadable hold must not let the steward race it.
    return true
  }
}

type SharedRows = () => Promise<SessionManageSidebarRow[]>

let rowsWithoutWindow: SharedRows | null = null

/**
 * Where the rules loop reads this host's own sessions when no window answers (the owner service's
 * remembered rows, observed live). Returns the restore.
 */
export function setStewardRowsWithoutWindow(next: SharedRows | null): () => void {
  const previous = rowsWithoutWindow
  rowsWithoutWindow = next
  return () => {
    rowsWithoutWindow = previous
  }
}

function readRows(runtime: OrcaRuntimeService): Promise<SessionManageSidebarRow[]> {
  return readSidebarRows(runtime).catch((error: unknown) => {
    const fallback = rowsWithoutWindow
    return fallback ? fallback() : Promise.reject(error)
  })
}

/** One sidebar read shared by a pass and the archive re-checks right behind it. */
function sharedRows(runtime: OrcaRuntimeService, now: () => number): SharedRows {
  let last: { at: number; rows: Promise<SessionManageSidebarRow[]> } | null = null
  return () => {
    if (!last || now() - last.at > ROWS_SHARED_MS) {
      const rows = readRows(runtime)
      last = { at: now(), rows }
      rows.catch(() => {
        last = null
      })
    }
    return last.rows
  }
}

/** Git head plus the working tree's changes: what "new evidence" means for a Yes. */
export async function readStewardGitEvidence(
  runtime: Pick<OrcaRuntimeService, 'getRuntimeGitStatus'>,
  worktreeId: string
): Promise<string | null> {
  try {
    const status = await runtime.getRuntimeGitStatus(`id:${worktreeId}`, {
      admissionTier: 'background',
      includeLineStats: false
    })
    const changes = status.entries.map((entry) => `${entry.status}:${entry.path}`).sort()
    const digest = createHash('sha256').update(JSON.stringify(changes)).digest('hex').slice(0, 16)
    return `${status.head ?? 'no-head'}|${digest}`
  } catch {
    return null
  }
}

export type StewardRuntimeSources = Omit<StewardPassDeps, 'store' | 'act' | 'detector'> & {
  tier2: StewardTier2Deps
  /** `session list`'s Stalled (while it holds) and waiters, from the steward's own state. */
  annotator: (state: Pick<StewardStateStore, 'session'>) => SessionManageEntryAnnotator
}

export function createStewardRuntimeSources(options: {
  runtime: OrcaRuntimeService
  store: Store
  ledger: () => Pick<OrganizationChangeLedger, 'history'>
  saveCard: StewardTier2Deps['saveCard']
  readCard: NonNullable<StewardTier2Deps['readCard']>
  now: () => number
  fresh?: FreshPaneEvidence
}): StewardRuntimeSources {
  const { runtime, now } = options
  const sources = createRuntimeObserveSources(runtime)
  const neverReplied = runtimeNeverReplied(runtime)
  const readRows = sharedRows(runtime, now)
  const jev: StewardJev = createStewardJev({
    settings: () =>
      normalizeNextStepSuggestionSettings(options.store.getSettings().nextStepSuggestions),
    nextStepJev: getNextStepJev
  })
  const latestTurn = (source: ConversationSource) => readRuntimeLatestTurn(source, neverReplied)
  const observe = (row: SessionManageSidebarRow) => observeSession(row, sources)
  const ownChains = (source: ConversationSource | null) =>
    source
      ? runtime
          .listSessionChains()
          .filter(
            (chain) =>
              chain.sourceRowKey === conversationSourceRowKey(source) ||
              addressesConversation(chain, source)
          )
      : []
  const personPrompted = runtimePersonPrompted(runtime, options.fresh)
  const tier2: StewardTier2Deps = {
    readRows: () => readSidebarRows(runtime),
    observe,
    reviewArchive: createArchiveReview(),
    readCompletion: (source) => upNextView(runtime, source),
    personPrompted: (row, observed) => personPrompted(row, observed),
    mutationGeneration: (row) => stewardMutationGeneration(runtime, row),
    chains: () => runtime.listSessionChains(),
    heldDelivery: isHeld,
    lastHookAt: (paneKey) => sources.lastHook(paneKey)?.updatedAt ?? null,
    lastHookRow: (paneKey) => runtime.getLastAgentHookRowForPane(paneKey),
    queuedPrompts: (row) => {
      const source = sessionManageSource(row)
      const queue = source ? sources.queue(source) : null
      return queue ? promptQueuePending(queue).length : 0
    },
    lastPersonActionAt: async (viewKey) => {
      const history = await options.ledger().history(viewKey)
      const person = history.entries.find((record) => record.executor.kind === 'person')
      return person ? Date.parse(person.ts) : null
    },
    latestTurn,
    jev,
    cardFacts: async (row, source, reply) => {
      const refs = sessionLinksInText(reply ?? '')
        .flatMap((link) => (link.pullRequest ? [link.pullRequest] : []))
        .slice(0, PULL_REQUEST_FACTS)
      const [goal, changed, facts] = await Promise.all([
        source ? jev.goal(source).catch(() => null) : null,
        runtimeReadChangedFiles(runtime)(row.worktreeId).catch(() => null),
        Promise.all(
          refs.map((ref) =>
            withTimeout(readSessionPullRequestFacts(ref), PULL_REQUEST_TIMEOUT_MS, null)
          )
        )
      ])
      const linked = getSessionLinkedDocsStore()
        ?.list()
        .find((entry) => entry.paneKey === row.paneKey)
      const latestPrompt = source
        ? getNextStepSuggestionService()?.latestTurns.get(conversationSourceRowKey(source))
            ?.lastUserPrompt
        : null
      return {
        goal:
          goal && latestPrompt?.trim()
            ? [
                'Recorded task or first prompt observed by this host (earlier turns may be missing):',
                goal,
                'Latest request:',
                latestPrompt
              ].join('\n')
            : null,
        changed,
        chains: ownChains(source),
        linkedDocs: linked?.docs ?? [],
        pullRequestFacts: facts.filter((fact) => fact !== null)
      }
    },
    saveCard: options.saveCard,
    readCard: options.readCard,
    now
  }
  // Why never throw: `session list` and the Work card read it; unreadable plans list no waiter.
  const stalledWaiters = (): ReadonlyMap<string, StewardStalledWaiter> => {
    try {
      return stalledWaitersFromChains(runtime.listSessionChains())
    } catch {
      return new Map()
    }
  }
  return {
    readRows,
    signature: (row) => {
      const source = sessionManageSource(row)
      const hook = row.paneKey ? sources.lastHook(row.paneKey) : null
      const chat = row.structuredSessionId ? sources.chat(row.structuredSessionId)?.reading : null
      const queue = source ? sources.queue(source) : null
      const turn = source ? snapshotRuntimeLatestTurn(source, neverReplied) : null
      return JSON.stringify([
        row.title,
        row.pinned,
        row.saved,
        row.hostUnavailable,
        row.launchPending,
        row.shellForeground,
        row.autoArchiveKeep ?? false,
        row.doneArchiveRevision,
        row.doneArchivePolicy,
        hook?.state ?? null,
        hook?.updatedAt ?? null,
        chat?.status ?? null,
        chat?.updatedAt ?? null,
        queue?.entries.length ?? 0,
        turn?.turnKey ?? null,
        turn?.proposal ?? null,
        source ? isKeepGoingOn(source) : false
      ])
    },
    observe,
    drivers: (row, source) => ({
      chainBound: source ? isChainBoundToConversation(runtime, source) : false,
      heldDelivery: row.paneKey ? isHeld(row.paneKey) : false
    }),
    readOwnSteps: readRuntimeOwnSteps,
    latestTurn,
    lastOutputAt: async (terminal) => {
      try {
        return (await runtime.showTerminal(terminal)).lastOutputAt
      } catch {
        return null
      }
    },
    jev,
    tier2,
    stalledWaiters,
    annotator: (state) => (entry, row) => {
      const own = entry.paneKey ? state.session(entry.paneKey)?.stalled : undefined
      const source = sessionManageSource(row)
      const turnKey = source ? snapshotRuntimeLatestTurn(source, neverReplied).turnKey : null
      const stalled =
        own && stewardStalledHolds(own, turnKey)
          ? own
          : entry.paneKey
            ? stalledWaiters().get(entry.paneKey)
            : undefined
      return {
        ...(stalled ? { stalled: { at: stalled.at, reason: stalled.reason } } : {}),
        waitedOnBy: sessionWaitersOf([row.paneKey, row.viewKey, row.rowKey])
      }
    },
    now
  }
}
