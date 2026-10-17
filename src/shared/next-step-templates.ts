import {
  defaultNextStepInstructions,
  emptyNextStepDraft,
  type NextStepActor,
  type NextStepAfterStep,
  type NextStepAgentRecipient,
  type NextStepDraft
} from './next-step-draft'
import type { SessionActionPresetId } from './session-action-presets'
import type { TuiAgent } from './tui-agent'

/**
 * Workflow templates are compositions of the same atomic actions; picking one fills the
 * same draft the picker edits. They are not a second engine and add no concept: a
 * template is what the person would have ticked and chosen by hand.
 */
export type NextStepTemplateId =
  | 'research-plan'
  | 'research-plan-create'
  | 'council'
  | 'compare-answers'
  | 'best-of-n'

export const NEXT_STEP_TEMPLATE_IDS: readonly NextStepTemplateId[] = [
  'research-plan',
  'research-plan-create',
  'council',
  'compare-answers',
  'best-of-n'
]

export type NextStepTemplateInput = {
  /** Agents the host has, in the order the picker lists them; the first is the default actor. */
  agents: readonly TuiAgent[]
  mintKey: () => string
}

export const COMPARE_ANSWERS_INSTRUCTIONS =
  'Answer the current request on your own, completely and with your reasoning. Save your answer as a file and list it in the manifest.'

/** Best of N: every candidate works alone; a neutral judge tries to break each; the best survives. */
export const BEST_OF_N_CANDIDATE_INSTRUCTIONS =
  'Produce the best complete result you can for the current request, on your own, without reading other candidates. Save the result as files and list them in the manifest with a short note on the trade-offs you chose.'

export const BEST_OF_N_JUDGE_INSTRUCTIONS =
  'You judge several candidate results for the same request; you wrote none of them. For every candidate, try to refute it: name concrete defects, missing requirements and unverified claims, and default to "does not pass" when unsure. Then rank the candidates best first. Save judgement.md with one section per candidate (verdict, evidence) and the ranking. Do not edit the candidates. End with exactly one line: OMNI_REVIEW_RESULT:{"status":"pass|findings","blockingFindings":["..."],"notes":"ranking: <candidate order>"}'

export const BEST_OF_N_SELECT_INSTRUCTIONS =
  "Read the judge's judgement.md and the candidates. Take the top-ranked candidate as the result, fold in any clearly better part of the others the judge named, and save the final result as new files (never overwrite the inputs). Record in the manifest which candidate won, the judge's ranking, and every part you merged in. Never present a candidate as best without the judge's ranking beside it."

function agentRecipient(
  input: NextStepTemplateInput,
  agent: TuiAgent,
  presetId: SessionActionPresetId
): NextStepAgentRecipient {
  return {
    kind: 'agent',
    key: input.mintKey(),
    agent,
    presetId,
    instructions: defaultNextStepInstructions(presetId),
    rounds: 1
  }
}

function afterAgent(
  input: NextStepTemplateInput,
  actor: NextStepActor,
  presetId: SessionActionPresetId,
  instructions = defaultNextStepInstructions(presetId)
): NextStepAfterStep {
  return {
    kind: 'agent',
    key: input.mintKey(),
    actor,
    presetId,
    instructions,
    rounds: 1
  }
}

/** Up to `count` distinct agents, cycling when the host has fewer. */
function pickAgents(agents: readonly TuiAgent[], count: number): TuiAgent[] {
  const chosen: TuiAgent[] = []
  for (let index = 0; index < count && agents.length > 0; index += 1) {
    chosen.push(agents[index % agents.length]!)
  }
  return chosen
}

/** The draft a template stands for, or null when the host has no agent to run it. */
export function nextStepTemplateDraft(
  id: NextStepTemplateId,
  input: NextStepTemplateInput
): NextStepDraft | null {
  const [first] = input.agents
  if (!first) {
    return null
  }
  const draft = emptyNextStepDraft()
  switch (id) {
    case 'research-plan':
      draft.recipients = [agentRecipient(input, first, 'research')]
      draft.after = [afterAgent(input, { agent: first }, 'plan')]
      return draft
    case 'research-plan-create':
      draft.recipients = [agentRecipient(input, first, 'research')]
      draft.after = [
        afterAgent(input, { agent: first }, 'plan'),
        afterAgent(input, { agent: first }, 'implement')
      ]
      return draft
    case 'council':
      draft.recipients = pickAgents(input.agents, 3).map((agent) =>
        agentRecipient(input, agent, 'review')
      )
      draft.after = [afterAgent(input, { agent: first }, 'synthesize')]
      return draft
    case 'compare-answers':
      // Why: the same question to each, answered independently; no build action is implied.
      draft.recipients = pickAgents(input.agents, 3).map((agent) => ({
        ...agentRecipient(input, agent, 'implement'),
        presetId: null,
        instructions: COMPARE_ANSWERS_INSTRUCTIONS
      }))
      draft.after = [afterAgent(input, { agent: first }, 'synthesize')]
      return draft
    case 'best-of-n': {
      // Why: the judge comes from a family none of the candidates belong to (estate rule);
      // with N families the candidates are the first N−1 and the judge is the last.
      const judge = input.agents.length > 1 ? input.agents.at(-1)! : first
      const candidates =
        input.agents.length > 1 ? input.agents.slice(0, -1) : pickAgents(input.agents, 2)
      draft.recipients = candidates.map((agent) => ({
        ...agentRecipient(input, agent, 'implement'),
        presetId: null,
        instructions: BEST_OF_N_CANDIDATE_INSTRUCTIONS
      }))
      draft.after = [
        afterAgent(input, { agent: judge }, 'review', BEST_OF_N_JUDGE_INSTRUCTIONS),
        afterAgent(input, { agent: judge }, 'synthesize', BEST_OF_N_SELECT_INSTRUCTIONS)
      ]
      return draft
    }
  }
}
