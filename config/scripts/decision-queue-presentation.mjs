import { queueTriageEnabled } from './decision-queue-configuration.mjs'
import { recordQueueHumanChoice } from './decision-queue-events.mjs'
import {
  evaluateQueueRecipe,
  persistQueueObservation,
  queueDeadline,
  queueText,
  unavailableQueueResult
} from './decision-queue-evaluation.mjs'

const recipeId = 'queue_presentation_triage'
const keep = (reason, disposition = 'insufficient_evidence') => ({
  status: reason,
  visibility: 'keep_visible',
  disposition,
  suggestion: null
})

// scope is supplied by the owning adapter, never inferred from model text.
export async function reconcileQueuePresentation(page, decisions, options = {}) {
  if (!queueTriageEnabled(options.environment)) {
    return keep('disabled')
  }
  if (
    !page ||
    page.scope !== 'presentation_only' ||
    !['id', 'title', 'question', 'revision'].every((key) => queueText(page[key])) ||
    !Array.isArray(page.evidenceRefs) ||
    !Array.isArray(decisions) ||
    !decisions.length ||
    decisions.length > 100
  ) {
    return keep('ineligible_or_missing_evidence')
  }
  const input = structuredClone({ page, decisions })
  const current = input.page
  if (input.decisions.some((decision) => !decision || typeof decision !== 'object')) {
    return keep('missing_evidence')
  }
  const evidence = input.decisions.map(({ id, revision, resolution, timestamp, sourceLink }) => ({
    id,
    revision,
    resolution,
    timestamp,
    sourceLink
  }))
  if (
    evidence.some(
      (decision) =>
        !['id', 'revision', 'resolution', 'sourceLink'].every((key) => queueText(decision[key])) ||
        !Number.isFinite(Date.parse(decision.timestamp))
    )
  ) {
    return keep('missing_evidence')
  }
  const eligible = evidence.filter(
    (decision) =>
      ['id', 'revision', 'resolution', 'sourceLink'].every((key) => queueText(decision[key])) &&
      Number.isFinite(Date.parse(decision.timestamp)) &&
      current.evidenceRefs.includes(decision.sourceLink) &&
      /^https?:\/\//.test(decision.sourceLink)
  )
  if (!eligible.length) {
    return keep('missing_evidence')
  }
  const started = performance.now()
  const remaining = queueDeadline(options)
  let result = unavailableQueueResult()
  let suggestion = null
  let matchedEvidence = null
  for (const decision of eligible) {
    const timeoutMs = remaining()
    if (!timeoutMs) {
      break
    }
    result = await evaluateQueueRecipe(
      recipeId,
      {
        page: JSON.stringify({
          title: current.title,
          question: current.question,
          revision: current.revision
        }),
        decision: JSON.stringify({ candidate: decision, authoritativeDecisions: evidence })
      },
      options,
      timeoutMs
    )
    if (result.status !== 'success' || result.disposition !== 'advisory') {
      break
    }
    const disposition = result.answers.scope.choice
    if (['exact_same_scope', 'superseded_subset'].includes(disposition)) {
      matchedEvidence = {
        id: decision.id,
        revision: decision.revision,
        timestamp: decision.timestamp,
        sourceLink: decision.sourceLink
      }
      suggestion = {
        queueItemId: current.id,
        suggestion: 'clear_from_queue',
        evidenceRef: decision.sourceLink,
        disposition,
        recipeId,
        recipeVersion: 1
      }
      break
    }
  }
  if (!queueTriageEnabled(options.environment)) {
    return keep('disabled')
  }
  const observationId = await persistQueueObservation(
    recipeId,
    { ...result, elapsedMs: performance.now() - started },
    input,
    {
      subjectId: current.id,
      itemIds: [current.id],
      suggestion,
      matchedEvidence,
      sourceRevision: current.revision
    },
    options
  )
  if (!observationId) {
    return keep('disabled')
  }
  return { ...keep('review', result.answers.scope?.choice), observationId, suggestion }
}

export function confirmQueuePresentation(event, options) {
  return recordQueueHumanChoice(recipeId, event, options)
}
