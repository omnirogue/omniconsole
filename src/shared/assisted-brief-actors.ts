import type { AttentionLaunchFavorite } from './attention-launch-favorites'
import { getCommitMessageAgentSpec } from './commit-message-agent-spec'
import type { BriefActor } from './assisted-brief-types'
import type { TuiAgent } from './tui-agent'

/**
 * The read-only one-shot CLI that drafts for an agent. A team favourite drafts with its
 * lead's CLI and model: polishing a brief never needs a team.
 */
export function briefOneShotAgent(agent: TuiAgent): TuiAgent | null {
  const candidate: TuiAgent = agent === 'claude-agent-teams' ? 'claude' : agent
  return getCommitMessageAgentSpec(candidate) ? candidate : null
}

export function briefActorForFavorite(favorite: AttentionLaunchFavorite): BriefActor | null {
  const agent = briefOneShotAgent(favorite.agent)
  if (!agent) {
    return null
  }
  return {
    agent,
    label: favorite.label,
    ...(favorite.model ? { model: favorite.model } : {}),
    ...(favorite.effort ? { effort: favorite.effort } : {}),
    ...(favorite.accountChoiceId ? { accountChoiceId: favorite.accountChoiceId } : {})
  }
}

export type BriefActorChoice = { favoriteId: string; actor: BriefActor }

/** Favourites that can draft or review, in saved order. */
export function briefActorChoices(
  favorites: readonly AttentionLaunchFavorite[]
): BriefActorChoice[] {
  return favorites.flatMap((favorite) => {
    const actor = briefActorForFavorite(favorite)
    return actor ? [{ favoriteId: favorite.id, actor }] : []
  })
}

export function describeBriefActor(actor: BriefActor): string {
  return actor.model ? `${actor.label} · ${actor.model}` : actor.label
}
