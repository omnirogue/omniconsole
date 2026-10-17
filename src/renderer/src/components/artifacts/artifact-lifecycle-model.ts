import type { ArtifactLastDecision, ArtifactListItem } from '../../../../shared/artifacts'

/** A new server always emits the lifecycle keys (null when unset); an older one omits them. */
export function artifactItemHasLifecycle(item: ArtifactListItem): boolean {
  return 'lifecycle' in item.artifact || 'needsYou' in item
}

export function artifactListHasLifecycle(items: readonly ArtifactListItem[]): boolean {
  return items.some(artifactItemHasLifecycle)
}

export function isArtifactReviewPage(item: ArtifactListItem): boolean {
  return item.artifact.review !== null && item.artifact.review !== undefined
}

/** Closed = closed by lifecycle or superseded (any page), as the server defines it. */
export function isArtifactClosed(item: ArtifactListItem): boolean {
  return Boolean(item.artifact.lifecycle) || Boolean(item.artifact.supersededBy)
}

export function artifactRevision(item: ArtifactListItem): number | null {
  return typeof item.artifact.revision === 'number' ? item.artifact.revision : null
}

/** The last decision when it was made on the page's current revision. */
export function artifactCurrentDecision(item: ArtifactListItem): ArtifactLastDecision | null {
  const decision = item.lastDecision ?? null
  const revision = artifactRevision(item)
  return decision && revision !== null && decision.revision === revision ? decision : null
}

export type ArtifactRowStatus =
  | { kind: 'superseded'; successorSlug: string }
  | { kind: 'done'; closedRef: string | null }
  | { kind: 'no_action' }
  | { kind: 'decided'; decision: ArtifactLastDecision['decision']; revision: number }
  | { kind: 'needs_you'; decidedAtRevision: number | null }
  | { kind: 'pending' }
  | { kind: 'none' }

/** Contract order, first match wins. */
export function deriveArtifactRowStatus(item: ArtifactListItem): ArtifactRowStatus {
  const { artifact } = item
  if (artifact.supersededBy) {
    return { kind: 'superseded', successorSlug: artifact.supersededBy }
  }
  if (artifact.lifecycle === 'done') {
    return { kind: 'done', closedRef: artifact.closedRef ?? null }
  }
  if (artifact.lifecycle === 'no_action') {
    return { kind: 'no_action' }
  }
  if (!isArtifactReviewPage(item)) {
    return { kind: 'none' }
  }
  const current = artifactCurrentDecision(item)
  if (current) {
    return { kind: 'decided', decision: current.decision, revision: current.revision }
  }
  if (artifact.review?.status !== 'pending') {
    return { kind: 'none' }
  }
  if (item.needsYou) {
    return { kind: 'needs_you', decidedAtRevision: item.lastDecision?.revision ?? null }
  }
  return { kind: 'pending' }
}

/** "…a3f2": the ledger id shortened to its tail, for a session this desktop cannot name. */
export function shortSessionRef(sessionRef: string): string {
  return `…${sessionRef.slice(-4)}`
}

export function capitalizeAgentName(agent: string): string {
  const trimmed = agent.trim()
  return trimmed ? `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}` : ''
}
