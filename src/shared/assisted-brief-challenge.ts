import {
  boundBriefText,
  currentBriefRevision,
  emptyBriefSections,
  reviseBrief
} from './assisted-brief-revisions'
import {
  ASSISTED_BRIEF_LIMITS,
  BRIEF_LIST_SECTIONS,
  type AssistedBriefRecord,
  type BriefActor,
  type BriefChallengeFinding,
  type BriefClock,
  type BriefItem
} from './assisted-brief-types'

/** Independent means a different agent, or at least a different model of the same agent. */
export function isIndependentReviewer(drafter: BriefActor, reviewer: BriefActor): boolean {
  return reviewer.agent !== drafter.agent || (reviewer.model ?? '') !== (drafter.model ?? '')
}

/** Prefers another agent; falls back to another model; null when only the drafter is available. */
export function chooseBriefReviewer(
  drafter: BriefActor,
  candidates: readonly BriefActor[]
): BriefActor | null {
  return (
    candidates.find((candidate) => candidate.agent !== drafter.agent) ??
    candidates.find((candidate) => isIndependentReviewer(drafter, candidate)) ??
    null
  )
}

export function canChallengeBrief(record: AssistedBriefRecord): boolean {
  return record.challengeCycles < ASSISTED_BRIEF_LIMITS.challengeCycles
}

export type BriefChallengeRefusal = 'cycle-used' | 'same-model'

/** Stores one review's findings as pending suggestions; the brief itself does not change. */
export function recordBriefChallenge(
  record: AssistedBriefRecord,
  reviewer: BriefActor,
  findings: readonly BriefChallengeFinding[],
  now: number
): AssistedBriefRecord | BriefChallengeRefusal {
  if (!canChallengeBrief(record)) {
    return 'cycle-used'
  }
  if (!isIndependentReviewer(record.drafter, reviewer)) {
    return 'same-model'
  }
  return {
    ...record,
    challenge: {
      revision: currentBriefRevision(record).number,
      reviewer,
      findings: findings.slice(0, ASSISTED_BRIEF_LIMITS.findings),
      status: 'open'
    },
    challengeCycles: record.challengeCycles + 1,
    updatedAt: now
  }
}

export function decideBriefFinding(
  record: AssistedBriefRecord,
  findingId: string,
  decision: BriefChallengeFinding['decision'],
  now: number
): AssistedBriefRecord {
  const challenge = record.challenge
  if (!challenge || challenge.status !== 'open') {
    return record
  }
  const findings = challenge.findings.map((finding) =>
    finding.id === findingId ? { ...finding, decision } : finding
  )
  return { ...record, challenge: { ...challenge, findings }, updatedAt: now }
}

/**
 * Applies the accepted findings as one revision and closes the review cycle. Pending and
 * rejected findings change nothing; added lines stay marked as the reviewer's suggestion.
 */
export function applyBriefChallenge(
  record: AssistedBriefRecord,
  clock: BriefClock
): AssistedBriefRecord {
  const challenge = record.challenge
  if (!challenge || challenge.status !== 'open') {
    return record
  }
  const accepted = challenge.findings.filter((finding) => finding.decision === 'accepted')
  const removeIds = new Set(
    accepted.flatMap((finding) =>
      finding.change.action === 'remove' ? [finding.change.targetItemId] : []
    )
  )
  const content = currentBriefRevision(record).content
  const sections = emptyBriefSections()
  let changes = 0
  for (const section of BRIEF_LIST_SECTIONS) {
    const kept = content.sections[section].filter((item) => !removeIds.has(item.id))
    const added: BriefItem[] = accepted.flatMap((finding) =>
      finding.change.action === 'add' && finding.change.section === section
        ? [{ id: clock.newId(), text: boundBriefText(finding.change.text), origin: 'challenge' }]
        : []
    )
    const next = [...kept, ...added].slice(0, ASSISTED_BRIEF_LIMITS.itemsPerSection)
    changes += content.sections[section].length - kept.length + (next.length - kept.length)
    sections[section] = next
  }
  const closed: AssistedBriefRecord = {
    ...record,
    challenge: { ...challenge, status: 'applied' },
    updatedAt: clock.now
  }
  return changes > 0
    ? reviseBrief(closed, { ...content, sections }, 'challenge-applied', clock.now)
    : closed
}
