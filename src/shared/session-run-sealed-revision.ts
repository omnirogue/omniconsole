import {
  sessionOutcomeDefinition,
  sessionOutcomeDefinitionSchema,
  type SessionOutcomeCommit,
  type SessionOutcomeDefinition,
  type SessionOutcomeSet
} from './session-outcome-types'

/** What any commit that would change a sealed run is told; new work forks a new run instead. */
export const SESSION_RUN_SEALED_ERROR =
  'This work is complete and sealed. New work starts a new run; this one cannot be edited.'

/** Key order is the caller's; the schema's own order is what makes two definitions comparable. */
function canonical(definition: SessionOutcomeDefinition): string | null {
  const parsed = sessionOutcomeDefinitionSchema.safeParse(sessionOutcomeDefinition(definition))
  return parsed.success ? JSON.stringify(parsed.data) : null
}

/** Whether a commit asks nothing of the run itself: at most, it files it under a card. */
function asksNothingNew(previous: SessionOutcomeSet, input: SessionOutcomeCommit): boolean {
  if (input.supersede || input.removals?.length || input.clearSessionFinish) {
    return false
  }
  const finish = input.sessionFinish
  if (
    finish &&
    (finish.action !== previous.sessionFinish?.action ||
      finish.folderId !== previous.sessionFinish?.folderId)
  ) {
    return false
  }
  return (
    input.outcomes.length === previous.outcomes.length &&
    input.outcomes.every((definition) => {
      const old = previous.outcomes.find((entry) => entry.id === definition.id)
      const next = canonical(definition)
      return Boolean(old && next && next === canonical(old))
    })
  )
}

/**
 * The one revision a sealed run accepts: filing it under a card. The seal, the disposition, every
 * receipt, attempt and request are carried exactly as they were proven; only the commit counter,
 * the filing and the write time move. Anything else is refused, so success cannot be edited away.
 */
export function reviseSealedSessionOutcomeSet(
  previous: SessionOutcomeSet,
  input: SessionOutcomeCommit,
  now: number
): SessionOutcomeSet {
  if (!asksNothingNew(previous, input)) {
    throw new Error(SESSION_RUN_SEALED_ERROR)
  }
  const sealed = structuredClone(previous)
  return {
    ...sealed,
    revision: previous.revision + 1,
    outcomes: sealed.outcomes.map((outcome) =>
      input.taskRef ? { ...outcome, taskRef: structuredClone(input.taskRef) } : outcome
    ),
    updatedAt: now
  }
}
