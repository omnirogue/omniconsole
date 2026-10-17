import { queueTriageEnabled } from './decision-queue-configuration.mjs'
import { withDecisionLedger } from './decision-record-ledger.mjs'
import { validateRecipeLedger } from './decision-recipe-outcomes.mjs'
import { validateQueueHumanChoice } from './decision-queue-validators.mjs'

export async function recordQueueHumanChoice(recipeId, event, options = {}) {
  if (!queueTriageEnabled(options.environment)) {
    return { status: 'disabled' }
  }
  return withDecisionLedger(options.ledgerPath, (rows) => {
    if (!queueTriageEnabled(options.environment)) {
      throw new Error('queue_triage_disabled')
    }
    const { byId, humanChoices = [] } = validateRecipeLedger(rows)
    const observation = byId.get(event.observationId)
    if (
      !observation?.queueTriage ||
      observation.recipeId !== recipeId ||
      humanChoices.some((row) => row.observationId === event.observationId)
    ) {
      throw new Error('invalid_or_duplicate_human_choice')
    }
    const context = observation.queueTriage
    const presentation = recipeId === 'queue_presentation_triage'
    const row = {
      schemaVersion: 1,
      kind: 'human_choice',
      recordedAt: new Date().toISOString(),
      observationId: event.observationId,
      recipeId,
      recipeVersion: observation.recipeVersion,
      subjectId: context.subjectId,
      inputDigest: context.inputDigest,
      ...(presentation ? { queueItemId: context.subjectId } : { groupId: context.subjectId }),
      evidenceRef: presentation ? context.suggestion?.evidenceRef : null,
      disposition: presentation ? context.suggestion?.disposition : 'draft_preference',
      humanChoice: event.humanChoice,
      chosenId: presentation ? null : event.chosenId,
      actor: event.actor,
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      elapsedMs: Date.parse(event.endedAt) - Date.parse(event.startedAt)
    }
    validateQueueHumanChoice(row, observation)
    return row
  })
}
