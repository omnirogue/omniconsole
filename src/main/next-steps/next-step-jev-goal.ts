import { readNextStepStartCard, type NextStepStartGeneratorDeps } from './next-step-start-generator'

export type NextStepGoalSources = {
  /** The hub card this conversation serves, when a client linked one. */
  taskId?: string
  readTaskCard?: NextStepStartGeneratorDeps['readTaskCard']
  /** The first prompt this host saw in the conversation. */
  firstPrompt?: string
  latestPrompt?: string
}

/** The goal JEV judges against: the card's title and next action, else the first prompt, else the latest. */
export async function resolveNextStepGoal(sources: NextStepGoalSources): Promise<string | null> {
  if (sources.taskId) {
    const card = await readNextStepStartCard(sources.readTaskCard, sources.taskId)
    if (!('unavailable' in card) && card.title.trim()) {
      return card.nextAction?.trim()
        ? `${card.title.trim()}\nNext action: ${card.nextAction.trim()}`
        : card.title.trim()
    }
  }
  return sources.firstPrompt?.trim() || sources.latestPrompt?.trim() || null
}
