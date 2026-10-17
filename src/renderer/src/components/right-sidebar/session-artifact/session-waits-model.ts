import { translate } from '@/i18n/i18n'
import { outcomeConditionProven } from '@/lib/session-run-event-wait'
import type { SessionChain } from '../../../../../shared/session-chain-types'
import {
  sessionOutcomeEventSourceLabel,
  type SessionOutcomeWaitFact
} from '../../../../../shared/session-outcome-event'
import type {
  SessionOutcome,
  SessionOutcomeCondition
} from '../../../../../shared/session-outcome-types'

const OWNER_CONTINUED = 'owner-continued:'

export type SessionWaitRow = {
  key: string
  outcomeId: string
  conditionId: string
  who: string
  where: string
  /** `continued` is met by the owner's "continue anyway", not by the answer itself. */
  status: 'met' | 'continued' | SessionOutcomeWaitFact['status']
  fact?: SessionOutcomeWaitFact
  /** When the answer arrived: the reading's own time, else the receipt's. */
  at?: number
  link?: string
}

export type SessionThenRow = { key: string; text: string; done: boolean }

export type SessionWaitsModel = {
  waits: SessionWaitRow[]
  after: SessionThenRow[]
  finish: 'end' | 'save' | null
}

function isWait(condition: SessionOutcomeCondition): boolean {
  return (
    (condition.kind === 'event' && Boolean(condition.event)) ||
    (condition.kind === 'review' && Boolean(condition.require))
  )
}

function localTime(iso: string | undefined): string {
  const at = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(at)
    ? new Date(at).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
    : '?'
}

function waitRow(outcome: SessionOutcome, condition: SessionOutcomeCondition): SessionWaitRow {
  const fact = outcome.waits?.find((entry) => entry.conditionId === condition.id)
  const receipt = outcome.evidence.find(
    (entry) => entry.conditionId === condition.id && entry.outcomeRevision === outcome.revision
  )
  const event = condition.event
  let who = event?.personName ?? fact?.by ?? condition.label ?? condition.target
  let where = ''
  let link = fact?.link
  if (event?.source === 'time') {
    who = translate('sessionWaits.until', 'until {{time}}', { time: localTime(event.at) })
  } else if (event?.source === 'github') {
    const number = /\/pull\/(\d+)$/.exec(event.ref ?? '')?.[1] ?? '?'
    who =
      event.match === 'merged'
        ? translate('sessionWaits.prMerge', 'PR #{{number}} to merge', { number })
        : translate('sessionWaits.prApproval', 'PR #{{number}} approval', { number })
    link = link ?? event.ref
  } else if (event) {
    where = sessionOutcomeEventSourceLabel(event.source)
  } else {
    where = translate('sessionWaits.toApprove', 'to approve')
  }
  const proven = outcomeConditionProven(outcome, condition.id)
  const status = proven
    ? receipt?.receipt.startsWith(OWNER_CONTINUED)
      ? 'continued'
      : 'met'
    : (fact?.status ?? 'pending')
  return {
    key: `${outcome.id}:${condition.id}`,
    outcomeId: outcome.id,
    conditionId: condition.id,
    who,
    where,
    status,
    ...(fact ? { fact } : {}),
    ...((fact?.at ?? receipt?.verifiedAt) ? { at: fact?.at ?? receipt?.verifiedAt } : {}),
    ...(link ? { link } : {})
  }
}

/** Outcomes that depend, directly or through others, on one with a wait, in dependency order. */
function dependentsInOrder(outcomes: readonly SessionOutcome[], waiting: Set<string>) {
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]))
  const blocked = new Map<string, boolean>()
  const behindWait = (id: string, seen: Set<string>): boolean => {
    if (blocked.has(id)) {
      return blocked.get(id)!
    }
    const outcome = byId.get(id)
    const result =
      !!outcome &&
      !seen.has(id) &&
      outcome.dependsOn.some((dep) => waiting.has(dep) || behindWait(dep, new Set([...seen, id])))
    blocked.set(id, result)
    return result
  }
  const ordered: SessionOutcome[] = []
  const placed = new Set<string>()
  const place = (outcome: SessionOutcome, trail: Set<string>): void => {
    if (placed.has(outcome.id) || trail.has(outcome.id)) {
      return
    }
    for (const dep of outcome.dependsOn) {
      const upstream = byId.get(dep)
      if (upstream && behindWait(dep, new Set())) {
        place(upstream, new Set([...trail, outcome.id]))
      }
    }
    placed.add(outcome.id)
    ordered.push(outcome)
  }
  for (const outcome of outcomes) {
    if (behindWait(outcome.id, new Set())) {
      place(outcome, new Set())
    }
  }
  return ordered
}

/** The read-only "Waiting on / Then" of a chain; null when nothing in it waits on anyone. */
export function sessionWaitsModel(chain: SessionChain | null): SessionWaitsModel | null {
  const set = chain?.outcomeSet
  if (!set) {
    return null
  }
  const waits = set.outcomes.flatMap((outcome) =>
    outcome.conditions.filter(isWait).map((condition) => waitRow(outcome, condition))
  )
  if (!waits.length) {
    return null
  }
  const waiting = new Set(waits.map((row) => row.outcomeId))
  const after = dependentsInOrder(set.outcomes, waiting).flatMap((outcome) =>
    outcome.actions.map((action) => ({
      key: `${outcome.id}:${action.id}`,
      text: action.instruction,
      done: outcome.status === 'satisfied'
    }))
  )
  const action = set.sessionFinish?.action
  return { waits, after, finish: action === 'end' || action === 'save' ? action : null }
}
