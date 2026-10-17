const text = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048

export function validateQueueObservation(row) {
  const value = row.queueTriage
  const presentation = row.recipeId === 'queue_presentation_triage'
  if (
    !value ||
    value.version !== 1 ||
    row.recipeVersion !== 1 ||
    !['queue_presentation_triage', 'lander_group_comparison'].includes(row.recipeId) ||
    !text(value.subjectId) ||
    !/^[a-f0-9]{64}$/.test(value.inputDigest) ||
    !Array.isArray(value.itemIds) ||
    !value.itemIds.length ||
    value.itemIds.some((id) => !text(id)) ||
    new Set(value.itemIds).size !== value.itemIds.length
  ) {
    throw new Error('invalid_queue_observation')
  }
  const suggestion = value.suggestion
  if (suggestion === null) {
    return
  }
  if (row.status !== 'success' || row.disposition !== 'advisory') {
    throw new Error('invalid_queue_suggestion')
  }
  if (presentation) {
    if (
      !suggestion ||
      suggestion.queueItemId !== value.subjectId ||
      suggestion.recipeId !== row.recipeId ||
      suggestion.recipeVersion !== row.recipeVersion ||
      suggestion.suggestion !== 'clear_from_queue' ||
      !text(suggestion.evidenceRef) ||
      !['exact_same_scope', 'superseded_subset'].includes(suggestion.disposition) ||
      row.answers.scope.choice !== suggestion.disposition ||
      !text(value.sourceRevision) ||
      !text(value.matchedEvidence?.id) ||
      !text(value.matchedEvidence?.revision) ||
      !Number.isFinite(Date.parse(value.matchedEvidence?.timestamp)) ||
      value.matchedEvidence?.sourceLink !== suggestion.evidenceRef
    ) {
      throw new Error('invalid_queue_suggestion')
    }
  } else {
    const ranks = value.rankings
    if (
      !suggestion ||
      !value.itemIds.includes(suggestion.winnerId) ||
      value.parity?.passed !== true ||
      !Array.isArray(ranks) ||
      ranks.length !== value.itemIds.length ||
      new Set(ranks.map((rank) => rank.id)).size !== ranks.length ||
      ranks.some(
        (rank) =>
          !value.itemIds.includes(rank.id) ||
          !Number.isFinite(rank.score) ||
          rank.score < 0 ||
          rank.score > 3 ||
          !Number.isFinite(rank.confidence) ||
          rank.confidence < 0.9 ||
          rank.confidence > 1
      ) ||
      ranks[0].id !== suggestion.winnerId ||
      ranks.slice(1).some((rank) => rank.score >= ranks[0].score)
    ) {
      throw new Error('invalid_queue_suggestion')
    }
  }
}

export function validateQueueHumanChoice(row, observation) {
  if (!observation?.queueTriage) {
    throw new Error('orphan_human_choice')
  }
  validateQueueObservation(observation)
  const context = observation.queueTriage
  const suggestion = context.suggestion
  if (
    row.schemaVersion !== 1 ||
    row.kind !== 'human_choice' ||
    row.recipeId !== observation.recipeId ||
    row.recipeVersion !== observation.recipeVersion ||
    row.subjectId !== context.subjectId ||
    row.inputDigest !== context.inputDigest ||
    !text(row.actor) ||
    !['confirmed', 'rejected', 'deferred_to_manual'].includes(row.humanChoice) ||
    !Number.isFinite(Date.parse(row.startedAt)) ||
    !Number.isFinite(Date.parse(row.endedAt)) ||
    row.elapsedMs !== Date.parse(row.endedAt) - Date.parse(row.startedAt) ||
    row.elapsedMs < 0 ||
    !Number.isFinite(Date.parse(row.recordedAt))
  ) {
    throw new Error('invalid_human_choice')
  }
  if (observation.recipeId === 'queue_presentation_triage') {
    if (
      !suggestion ||
      !['confirmed', 'rejected'].includes(row.humanChoice) ||
      row.queueItemId !== context.subjectId ||
      row.evidenceRef !== suggestion.evidenceRef ||
      row.disposition !== suggestion.disposition ||
      row.chosenId !== null
    ) {
      throw new Error('invalid_human_choice')
    }
  } else if (
    row.groupId !== context.subjectId ||
    row.evidenceRef !== null ||
    row.disposition !== 'draft_preference' ||
    row.humanChoice === 'rejected' ||
    (row.humanChoice === 'confirmed'
      ? !suggestion || row.chosenId !== suggestion.winnerId
      : row.chosenId !== null)
  ) {
    throw new Error('invalid_human_choice')
  }
}
