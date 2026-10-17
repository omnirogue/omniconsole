import type {
  OrganizationExecutor,
  OrganizationRecord
} from '../../../../shared/session-organization-change'
import type {
  SessionStewardActivity,
  SessionStewardActivityKind,
  StewardResultCard
} from '../../../../shared/session-steward-status'

/** Changes made for the person, not by them: one request (or one actor's run) per group. */
export type StewardActivityGroup = {
  key: string
  /** The person's own words that asked for it, when the change carried them. */
  request: string | null
  executor: OrganizationExecutor
  records: OrganizationRecord[]
  /** Sessions touched, counting each change's targets. */
  targetCount: number
  /** The group's changes Undo can still put back, newest first. */
  undoable: string[]
  latestTs: string
}

function runKey(executor: OrganizationExecutor): string {
  switch (executor.kind) {
    case 'pane':
      return `pane:${executor.paneKey}`
    case 'launch':
      return `launch:${executor.source}`
    case 'app':
      return `app:${executor.feature}`
    case 'sync':
      return 'sync'
    case 'cli':
      return 'cli'
    case 'person':
      return `person:${executor.via}`
  }
}

/**
 * Non-person applied changes grouped by the request that asked for them, else by who ran them.
 * Undo records of the person's own are left out: they are the person's, not the steward's.
 */
export function stewardActivityGroups(
  entries: readonly OrganizationRecord[],
  undoable: ReadonlySet<string>
): StewardActivityGroup[] {
  const groups = new Map<string, StewardActivityGroup>()
  for (const record of entries) {
    if (record.phase !== 'applied' || record.executor.kind === 'person') {
      continue
    }
    const request = record.request?.trim() || null
    const key = request ? `request:${request}` : `run:${runKey(record.executor)}`
    const group = groups.get(key) ?? {
      key,
      request,
      executor: record.executor,
      records: [],
      targetCount: 0,
      undoable: [],
      latestTs: record.ts
    }
    group.records.push(record)
    group.targetCount += record.targets.length
    if (undoable.has(record.opId)) {
      group.undoable.push(record.opId)
    }
    if (record.ts > group.latestTs) {
      group.latestTs = record.ts
    }
    groups.set(key, group)
  }
  const newestFirst = (left: { ts: string }, right: { ts: string }): number =>
    left.ts < right.ts ? 1 : left.ts > right.ts ? -1 : 0
  return [...groups.values()]
    .map((group) => {
      const records = [...group.records].sort(newestFirst)
      const order = new Map(records.map((record, index) => [record.opId, index]))
      return {
        ...group,
        records,
        undoable: [...group.undoable].sort(
          (left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0)
        )
      }
    })
    .sort((left, right) => newestFirst({ ts: left.latestTs }, { ts: right.latestTs }))
}

/** Finished sessions archived since the person last looked, then the rest; newest first. */
export function stewardFinishedView(
  cards: readonly StewardResultCard[],
  seenAt: number
): { unseen: StewardResultCard[]; seen: StewardResultCard[] } {
  const at = (card: StewardResultCard): number => card.archivedAt ?? card.builtAt
  const sorted = [...cards].sort((left, right) => at(right) - at(left))
  return {
    unseen: sorted.filter((card) => at(card) > seenAt),
    seen: sorted.filter((card) => at(card) <= seenAt)
  }
}

/** How many of each move the steward made in the activity it reported. */
export function stewardMoveCounts(
  activity: readonly SessionStewardActivity[]
): Partial<Record<SessionStewardActivityKind, number>> {
  const counts: Partial<Record<SessionStewardActivityKind, number>> = {}
  for (const entry of activity) {
    counts[entry.kind] = (counts[entry.kind] ?? 0) + 1
  }
  return counts
}
