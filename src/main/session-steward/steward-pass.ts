/**
 * One rules pass: ONE inventory read, then only the sessions whose cheap signature changed (turn,
 * hook report, queue, Keep going, row flags) or whose next check is due are observed and judged.
 * Each is skipped first when something already drives it, then gets at most one steward move:
 * a safe Yes, a nudge, an "are you done?" question, a Tier 2 archive, or a report (Stalled,
 * silent). The pile-up detector runs last.
 */

import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { ConversationSource } from '../../shared/conversation-source'
import { toSessionManageEntry } from '../session-manage/session-manage-inventory'
import type { ObservedSession } from '../session-manage/session-manage-observe'
import type { SessionOwnSteps } from '../session-manage/session-manage-steps'
import type { SessionLatestTurn } from '../session-manage/session-manage-freeform'
import type { StewardActions } from './steward-actions'
import type { StewardJev } from './steward-jev'
import type { StewardLeftover, StewardPileupDetector } from './steward-pileup-detector'
import { STEWARD_RECHECK_MS, stewardSkipReason, type StewardDrivers } from './steward-rules'
import type { StewardStalledWaiter } from './steward-stalled-waiters'
import type { StewardStateStore } from './steward-state-store'
import type { StewardTier2Deps } from './steward-tier2-check'
import { judgeStewardRow, type StewardRowOutcome } from './steward-row'
import { isRemoteBlankCandidate } from './steward-remote-blank-rule'

const OBSERVE_CONCURRENCY = 8
/** JEV shares 6 slots with the rest of the app; the steward keeps to a few of them. */
const JUDGE_CONCURRENCY = 3

export type StewardPassDeps = {
  readRows: () => Promise<SessionManageSidebarRow[]>
  /** Cheap, in-memory: changes whenever the session may have moved. */
  signature: (row: SessionManageSidebarRow) => string
  observe: (row: SessionManageSidebarRow) => Promise<ObservedSession>
  drivers: (row: SessionManageSidebarRow, source: ConversationSource | null) => StewardDrivers
  readOwnSteps: (source: ConversationSource) => Promise<SessionOwnSteps>
  latestTurn: (source: ConversationSource) => Promise<SessionLatestTurn>
  lastOutputAt: (terminal: string) => Promise<number | null>
  jev: StewardJev
  tier2: StewardTier2Deps
  store: StewardStateStore
  act: StewardActions
  detector: Pick<StewardPileupDetector, 'run'>
  /** Waiters whose next step is blocked "Stalled: …" (WP-S3), by waiting pane. */
  stalledWaiters: () => ReadonlyMap<string, StewardStalledWaiter>
  now: () => number
}

export type StewardPassMemory = {
  seen: Map<string, { signature: string; recheckAt: number }>
  /** Finished sessions Tier 2 would not archive, by pane. */
  leftovers: Map<string, StewardLeftover>
  silent: Map<string, { title: string; since: number; minutes: number }>
  /** `pane|turn|what` already recorded, so a repeated reading is noted once. */
  noted: Set<string>
  /** Each listed pane's title at the last pass, for reports that only hold a pane key. */
  titles: Map<string, string>
}

export function emptyStewardPassMemory(): StewardPassMemory {
  return {
    seen: new Map(),
    leftovers: new Map(),
    silent: new Map(),
    noted: new Set(),
    titles: new Map()
  }
}

export type StewardPassResult = { rows: number; observed: number; outcomes: StewardRowOutcome[] }

function forget(memory: StewardPassMemory, live: ReadonlySet<string>): void {
  for (const map of [memory.seen, memory.leftovers, memory.silent, memory.titles]) {
    for (const key of map.keys()) {
      if (!live.has(key)) {
        map.delete(key)
      }
    }
  }
  if (memory.noted.size > 2_000) {
    memory.noted.clear()
  }
}

function stalledLeftovers(
  deps: Pick<StewardPassDeps, 'store' | 'stalledWaiters'>,
  memory: StewardPassMemory,
  live: ReadonlySet<string>
): StewardLeftover[] {
  const own = Object.entries(deps.store.read().sessions).flatMap(([paneKey, state]) =>
    state.stalled && live.has(paneKey)
      ? [
          {
            paneKey,
            title: state.title ?? paneKey,
            kind: 'stalled' as const,
            reason: state.stalled.reason,
            since: state.stalled.at
          }
        ]
      : []
  )
  const listed = new Set(own.map((leftover) => leftover.paneKey))
  const waiters = [...deps.stalledWaiters()]
    .filter(([paneKey]) => !listed.has(paneKey))
    .map(([paneKey, waiter]) => ({
      paneKey,
      title: memory.titles.get(paneKey) ?? paneKey,
      kind: 'stalled' as const,
      reason: waiter.reason,
      since: waiter.at
    }))
  return [...own, ...waiters]
}

export async function runStewardPass(
  deps: StewardPassDeps,
  memory: StewardPassMemory
): Promise<StewardPassResult> {
  const rows = (await deps.readRows()).filter((row) => !row.folded && row.paneKey && !row.archived)
  const live = new Set(rows.map((row) => row.paneKey!))
  forget(memory, live)
  for (const row of rows) {
    memory.titles.set(row.paneKey!, row.title)
  }
  const now = deps.now()
  // Why the signature before observing: a change made while a row is judged reads as a change.
  const changed = rows.flatMap((row) => {
    const seen = memory.seen.get(row.paneKey!)
    const signature = deps.signature(row)
    return !seen || seen.signature !== signature || now >= seen.recheckAt
      ? [{ row, signature }]
      : []
  })
  const observed = await mapWithConcurrency(changed, OBSERVE_CONCURRENCY, ({ row, signature }) =>
    deps.observe(row).then(
      (session) => ({ row, signature, session }),
      () => null
    )
  )
  const outcomes = await mapWithConcurrency(
    observed.filter((item) => item !== null),
    JUDGE_CONCURRENCY,
    async ({ row, signature, session }) => {
      const entry = toSessionManageEntry(session)
      const drivers = deps.drivers(row, session.source)
      const skip = stewardSkipReason(row, entry, drivers)
      // Why: an unknown state or an SSH host holds every rule but the blank ones.
      const blankCandidate =
        skip !== null &&
        ((entry.verdict === 'live' &&
          entry.state === 'unknown' &&
          stewardSkipReason(row, { ...entry, state: 'idle' }, drivers) === null) ||
          isRemoteBlankCandidate(row, entry, drivers))
      const judged =
        !skip || blankCandidate
          ? await judgeStewardRow(deps, memory, row, session, entry).catch(
              (error: unknown): StewardRowOutcome => ({
                paneKey: row.paneKey!,
                action: 'error',
                detail: error instanceof Error ? error.message : String(error)
              })
            )
          : null
      const outcome: StewardRowOutcome =
        judged && !(skip && judged.action === 'none')
          ? judged
          : {
              paneKey: row.paneKey!,
              action: 'skip',
              detail: skip!,
              ...(judged?.recheckAt !== undefined ? { recheckAt: judged.recheckAt } : {})
            }
      if (outcome.action === 'skip') {
        memory.leftovers.delete(row.paneKey!)
        memory.silent.delete(row.paneKey!)
      }
      memory.seen.set(row.paneKey!, {
        signature,
        recheckAt: Math.min(outcome.recheckAt ?? Infinity, deps.now() + STEWARD_RECHECK_MS)
      })
      return outcome
    }
  )
  await deps.detector.run([...stalledLeftovers(deps, memory, live), ...memory.leftovers.values()])
  return { rows: rows.length, observed: observed.length, outcomes }
}
