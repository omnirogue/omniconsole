import {
  sessionOutcomeCanonicalSeal,
  type SessionOutcomeCanonicalSeal
} from '../../shared/session-outcome-workflow'

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
/** The Hub revision digest seals a different graph than the BFF authoring digest. */
export function readSessionOutcomeCanonicalSeal(
  payload: unknown,
  workflowId: string
): SessionOutcomeCanonicalSeal {
  const receipt = object(object(payload)?.receipt)
  const revision = object(receipt?.revision)
  const seal = sessionOutcomeCanonicalSeal.parse({
    workflow_id: revision?.workflow_id,
    revision_id: revision?.revision_id,
    graph_digest: revision?.graph_digest
  })
  if (receipt?.workflow_id !== workflowId || seal.workflow_id !== workflowId) {
    throw new Error('Admission changed the canonical workflow identity.')
  }
  return seal
}
export function hasSessionOutcomeCanonicalProjection(
  projection: Record<string, unknown> | undefined,
  seal: SessionOutcomeCanonicalSeal | undefined
): boolean {
  return Boolean(
    seal &&
    projection &&
    projection.revision_id === seal.revision_id &&
    projection.graph_digest === seal.graph_digest &&
    (projection.workflow_id === undefined || projection.workflow_id === seal.workflow_id)
  )
}
