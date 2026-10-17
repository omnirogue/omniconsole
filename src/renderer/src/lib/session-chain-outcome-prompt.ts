import type { SessionOutcomeSet } from '../../../shared/session-outcome-types'

/** Carry every obligation through each successor; evidence stays referenced, not reasserted. */
export function buildSessionOutcomeContext(outcomeSet: SessionOutcomeSet | undefined): string {
  if (!outcomeSet) {
    return ''
  }
  const outcomes = outcomeSet.outcomes.map((outcome, index) => {
    const conditions = outcome.conditions
      .map((condition) => `${condition.id}: ${condition.kind} ${condition.target}`)
      .join('; ')
    return [
      `${index + 1}. [${outcome.status}] ${outcome.title} (${outcome.id}, revision ${outcome.revision})`,
      outcome.instructions ? `Instructions: ${outcome.instructions}` : null,
      `Finish: ${outcome.finish}. Conditions: ${conditions}`,
      outcome.dependsOn.length > 0 ? `Depends on: ${outcome.dependsOn.join(', ')}` : null
    ]
      .filter((line): line is string => line !== null)
      .join('\n')
  })
  return `Committed outcomes (all remain binding until individually satisfied):\n${outcomes.join('\n')}`
}
