import type { NextOutcomeTeamUsableAgent } from '../../next-outcome-team-plan-schema'
import type { WorkPlanActor, WorkPlanContext } from '../../work-plan-types'

/** A realistic host: four model families that may decide, plus Gemini, which may not. */
export const WORK_PLAN_FIXTURE_ACTORS = {
  claude: { agent: 'claude', model: 'opus-4', effort: 'high' },
  codex: { agent: 'codex', model: 'gpt-5-codex', effort: 'high' },
  grok: { agent: 'grok', model: 'grok-4', effort: 'high' },
  kimi: { agent: 'kimi', model: 'k2', effort: 'high' },
  gemini: { agent: 'gemini', model: 'gemini-3-pro', effort: 'high' }
} as const satisfies Record<string, WorkPlanActor>

export function workPlanFixtureUsableAgents(): NextOutcomeTeamUsableAgent[] {
  return Object.values(WORK_PLAN_FIXTURE_ACTORS).map((actor) => ({
    agent: actor.agent,
    models: [{ id: actor.model, label: actor.model, efforts: ['high'] }]
  }))
}

export function workPlanFixtureContext(overrides: Partial<WorkPlanContext> = {}): WorkPlanContext {
  return {
    usableAgents: workPlanFixtureUsableAgents(),
    source: { agent: 'claude', model: 'opus-4' },
    placement: 'local',
    accountCatalogue: [],
    commitSource: 'user',
    capabilities: { sameConversationRoute: false },
    ...overrides
  }
}
