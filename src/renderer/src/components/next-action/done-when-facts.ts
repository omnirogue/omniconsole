import { sessionOutcomeEventSourceLabel } from '../../../../shared/session-outcome-event'
import { translate } from '@/i18n/i18n'
import type { SessionChain } from '../../../../shared/session-chain-types'
import type {
  SessionOutcome,
  SessionOutcomeCondition
} from '../../../../shared/session-outcome-types'

/** One Done When condition as the head reads it: its own words, and whether a receipt proved it. */
export type DoneWhenItem = {
  /** Stable across a reword: the outcome and condition ids, never the prose. */
  key: string
  outcomeId: string
  conditionId: string
  /**
   * What a person reads: their own words when they wrote some, else the target said humanly — a
   * person's name for a handoff, a file's basename for a file — never a bare id or a full path.
   */
  label: string
  /** The identifier behind the label (the id, the full path), for `title=`; equal to `target`. */
  detail: string
  target: string
  met: boolean
  receipt?: string
  verifiedAt?: number
  /**
   * The owner's OWN review of a prepared result version, still open: the one condition the person
   * answers here. A named reviewer's condition is theirs to answer, never the owner's.
   */
  ownReview?: { version: string }
}

export type DoneWhenFacts = {
  items: DoneWhenItem[]
  met: number
  total: number
  /** The still-open conditions, in plan order, for "· open: …". */
  open: DoneWhenItem[]
}

/**
 * Evidence counts only under the outcome's CURRENT revision: `reviseSessionOutcomeSet` re-stamps
 * every receipt it retains, so a reworded condition keeps its tick while a genuinely changed one
 * loses it. Reading the stored revision is what makes a pip a fact rather than a guess.
 */
function conditionReceipt(outcome: SessionOutcome, conditionId: string) {
  return outcome.evidence.find(
    (receipt) => receipt.conditionId === conditionId && receipt.outcomeRevision === outcome.revision
  )
}

/**
 * Every person the chain already names, by employee id. The handoff steps carry the display
 * name the person was chosen by (`SessionFollowUpRecipient.name`), so the head needs no roster
 * round trip to say "Sal" instead of "emp_sal"; an id nobody on the chain knows stays an id.
 */
export function chainPersonNames(chain: SessionChain | null | undefined): Map<string, string> {
  const names = new Map<string, string>()
  for (const step of chain?.steps ?? []) {
    if (step.kind !== 'handoff') {
      continue
    }
    for (const recipient of step.handoff.recipients) {
      if (recipient.name.trim()) {
        names.set(recipient.employeeId, recipient.name.trim())
      }
    }
  }
  return names
}

/** The last path segment, for either separator; a target with no separator is its own name. */
export function fileBasename(target: string): string {
  const trimmed = target.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return (cut === -1 ? trimmed : trimmed.slice(cut + 1)) || target
}

/** The target in a person's words when the condition carries none of its own. */
export function humanConditionTarget(
  condition: Pick<SessionOutcomeCondition, 'kind' | 'target' | 'recipientId' | 'event'>,
  names: Map<string, string>
): string {
  switch (condition.kind) {
    case 'event':
      return condition.event?.personName && condition.event.source !== 'time'
        ? `${condition.event.personName} ${sessionOutcomeEventSourceLabel(condition.event.source)}`
        : condition.target
    case 'handoff':
    case 'review':
      return (
        names.get(condition.recipientId ?? condition.target) ??
        names.get(condition.target) ??
        condition.target
      )
    case 'file':
      return fileBasename(condition.target)
    case 'pr':
    case 'merge':
    case 'deployment':
    case 'command':
    case 'report':
    case 'session':
      return condition.target
  }
}

export function doneWhenFacts(chain: SessionChain | null | undefined): DoneWhenFacts {
  const names = chainPersonNames(chain)
  const items = (chain?.outcomeSet?.outcomes ?? []).flatMap((outcome) =>
    outcome.conditions.map((condition) => {
      const receipt = conditionReceipt(outcome, condition.id)
      return {
        key: `${outcome.id}:${condition.id}`,
        outcomeId: outcome.id,
        conditionId: condition.id,
        label: condition.label?.trim() || humanConditionTarget(condition, names),
        detail: condition.target,
        target: condition.target,
        met: Boolean(receipt),
        receipt: receipt?.receipt,
        verifiedAt: receipt?.verifiedAt,
        ...(!receipt && condition.kind === 'review' && !condition.recipientId && condition.version
          ? { ownReview: { version: condition.version } }
          : {})
      }
    })
  )
  return {
    items,
    met: items.filter((item) => item.met).length,
    total: items.length,
    open: items.filter((item) => !item.met)
  }
}

/**
 * The one sentence the head shows. A conversation with no chain yet has none — this reader never
 * invents one, because only a committed outcome set is an outcome (the pursuit boundary).
 */
export function outcomeSentence(chain: SessionChain | null | undefined): string | null {
  return chain?.outcomeSet?.outcomes[0]?.title ?? null
}

/**
 * "1 of 3 Done When", the count under the sentence. It names what it counts: a bare "0 of 2" read
 * as stages, and these are the conditions of EVERY outcome (the host's summary counts the same).
 */
export function doneWhenCountLabel(facts: Pick<DoneWhenFacts, 'met' | 'total'>): string {
  return translate('nextAction.doneWhenCount', '{{met}} of {{total}} Done When', {
    met: facts.met,
    total: facts.total
  })
}

/** Past this many names the line counts them first, so a long list still reads at a glance. */
const OPEN_NAMES_COUNTED_FROM = 3

export type DoneWhenOpenParts = {
  /** "· open:" for a short list; "· 4 open ·" once the list is long. */
  lead: string
  names: { key: string; label: string; detail: string }[]
}

/** The open conditions as the head lays them out: a lead, then each name with its detail. */
export function doneWhenOpenParts(facts: Pick<DoneWhenFacts, 'open'>): DoneWhenOpenParts {
  const names = facts.open.map((item) => ({
    key: item.key,
    label: item.label,
    detail: item.detail
  }))
  const lead =
    names.length >= OPEN_NAMES_COUNTED_FROM
      ? translate('nextAction.doneWhenOpenCounted', '· {{count}} open ·', { count: names.length })
      : translate('nextAction.doneWhenOpenLead', '· open:')
  return { lead, names }
}
