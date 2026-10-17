import {
  WORKFLOW_IMPROVE_PROMPT_KEYS,
  WORKFLOW_MAX_INSTRUCTION_CHARS,
  type WorkflowImprovePromptKey,
  type WorkflowImprovePrompts
} from './workflow-graph'
import { cleanBlock } from './workflow-spec-coercion'

/**
 * Improve's built-in instructions: what each improver role is asked to do, and the rules every
 * version follows. A person may reword any of them; a run freezes the wording it used.
 */
export const WORKFLOW_IMPROVE_DEFAULT_PROMPTS: Record<WorkflowImprovePromptKey, string> = {
  first:
    'Produce a complete solution to the task below, as good as you can make it. Later rounds will try to beat it, so make every part count.',
  improve:
    'Below is the best version so far. Make a complete version that is clearly better: keep what makes it strong, fix its weaknesses and everything the judges criticised, and add what is missing.',
  explore:
    'Solve the task with a substantially different approach: different from the best version below, or in the first round from the most obvious approach. Do not polish the best version; make yours complete and able to beat it.',
  divergent:
    'Rounds of improving the best version below have stopped helping. Challenge the assumptions behind it and solve the task with a fundamentally different approach, outside its family of solutions. Aim to beat it, not to vary it.',
  rules: [
    '- Stay on the original task above: never drift to an easier, narrower or different goal that merely looks better.',
    // Why: in live runs improvers invented product facts ("4K", "20 free renders") and kept them after the judges objected.
    '- State only facts the task and the material above give. Never invent specifics about the real product, people or world (numbers, prices, features, names, results, quotes); where one is needed but not given, write a clearly marked placeholder such as [price], or leave it out. Fiction and hypotheticals the task asks for are fine.',
    '- Return the whole finished work, ready to use as it is: no preamble, no list of changes, no notes about earlier versions.'
  ].join('\n')
}

/** The wording one instruction uses: the person's own when set, else the built-in one. */
export function workflowImprovePrompt(
  prompts: WorkflowImprovePrompts | undefined,
  key: WorkflowImprovePromptKey
): string {
  return prompts?.[key]?.trim() || WORKFLOW_IMPROVE_DEFAULT_PROMPTS[key]
}

/** The person's own Improve wording from a saved or compiled spec. */
export function normalizeImprovePrompts(raw: unknown): { prompts?: WorkflowImprovePrompts } {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  const prompts: WorkflowImprovePrompts = {}
  for (const key of WORKFLOW_IMPROVE_PROMPT_KEYS) {
    const text = cleanBlock(record?.[key], WORKFLOW_MAX_INSTRUCTION_CHARS)
    // Only the person's own wording is kept, so the built-in wording can still improve.
    if (text && text !== WORKFLOW_IMPROVE_DEFAULT_PROMPTS[key]) {
      prompts[key] = text
    }
  }
  return Object.keys(prompts).length ? { prompts } : {}
}
