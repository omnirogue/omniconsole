import { OUTCOME_AGENT_MISSION } from '../../../shared/outcome-agent-mission'
import {
  renderSessionActionTemplate,
  resolveSessionActionPreset,
  type SessionActionPresetSettings
} from '../../../shared/session-action-presets'
import {
  sessionChainStepOutputDir,
  type SessionChain,
  type SessionChainAgentStep
} from '../../../shared/session-chain-types'
import type { SessionReviewAssignment } from '../../../shared/session-chain-review'
import { buildSessionReviewInstructions } from './session-chain-review-prompt'
import { buildSessionOutcomeContext } from './session-chain-outcome-prompt'

export const SESSION_CHAIN_INPUT_LINE_LIMIT = 120
export const SESSION_CHAIN_INPUT_CHAR_LIMIT = 12_000

type PresetSettings = {
  sessionActionPresets?: SessionActionPresetSettings
  sessionActionPresetsByWorkspace?: Record<string, SessionActionPresetSettings>
}

/** Keep the inlined tail bounded; produced files travel by path, never inlined. */
export function boundSessionChainInput(text: string): string {
  if (text.length <= SESSION_CHAIN_INPUT_CHAR_LIMIT) {
    return text
  }
  return `…${text.slice(text.length - SESSION_CHAIN_INPUT_CHAR_LIMIT)}`
}

/**
 * The prompt a chain step launches with. Without a preset the typed instruction is
 * the prompt, plus the mechanical handoff (output folder and previous files) so even
 * a free-form step knows where to write. With a preset the template is rendered.
 */
export function buildSessionChainStepPrompt(args: {
  settings: PresetSettings | null | undefined
  chain: Pick<SessionChain, 'id' | 'workspacePath' | 'outcomeSet'>
  step: Pick<SessionChainAgentStep, 'id' | 'prompt' | 'presetId'> & {
    review?: SessionReviewAssignment
  }
  previousOutput: string
  previousFiles: readonly string[]
}): { prompt: string; outputDir: string } {
  const outputDir = sessionChainStepOutputDir(args.chain.workspacePath, args.chain.id, args.step.id)
  const values = {
    objective: args.step.prompt.trim(),
    input: boundSessionChainInput(args.previousOutput),
    inputFiles: args.previousFiles.join('\n'),
    outputDir,
    workspacePath: args.chain.workspacePath
  }
  const objective = args.step.review
    ? `${args.step.prompt.trim()}\n\n${buildSessionReviewInstructions(args.step.review, { stepId: args.step.id })}`
    : args.step.prompt.trim()
  const outcomeContext = buildSessionOutcomeContext(args.chain.outcomeSet)
  const objectiveWithOutcomes = outcomeContext ? `${objective}\n\n${outcomeContext}` : objective
  values.objective = objectiveWithOutcomes
  if (args.step.presetId) {
    const preset = resolveSessionActionPreset(
      args.settings,
      args.chain.workspacePath,
      args.step.presetId
    )
    return {
      prompt: `${OUTCOME_AGENT_MISSION}\n\n${renderSessionActionTemplate(preset.template, values)}`,
      outputDir
    }
  }
  const handoff = [
    args.previousFiles.length > 0 ? `Files from the previous step:\n${values.inputFiles}` : null,
    `Workspace: ${values.workspacePath}\nWrite anything you produce into ${outputDir} and finish with a manifest at ${outputDir}/manifest.md listing each produced file.`
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n')
  return { prompt: `${OUTCOME_AGENT_MISSION}\n\n${objectiveWithOutcomes}\n\n${handoff}`, outputDir }
}
