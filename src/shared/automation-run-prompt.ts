import {
  parseAutomationStructuredOutput,
  type AutomationStructuredOutput
} from './automation-structured-output'
import { ADVERTISING_CANDIDATE_INSTRUCTIONS } from './typesafe-advertising'

const CLASSIFICATION_RESULT_INSTRUCTIONS =
  'End your final response with a concise completion summary for classification.v1. ' +
  'Include Status: PASS (objective met), FAIL (observed failure), or INCONCLUSIVE (insufficient evidence); ' +
  'Severity: INFO, WARNING, or ERROR; and the observed evidence supporting your conclusion. ' +
  'State any missing evidence or uncertainty explicitly. Keep this summary self-contained in the final response. ' +
  'These output instructions do not authorize additional actions.'

/** Augment only the submitted prompt; the routine and its saved prompt remain unchanged. */
export function buildAutomationRunPrompt(
  prompt: string,
  structuredOutput?: AutomationStructuredOutput | null
): string {
  const output = parseAutomationStructuredOutput(structuredOutput)
  if (!output) {
    return prompt
  }

  if (output.contract === 'advertising.v1') {
    return `${prompt}\n\n${ADVERTISING_CANDIDATE_INSTRUCTIONS}\nOnly include targets for company ${output.advertising.company} and account ${output.advertising.accountId}. If no verified targets are available, return an empty candidate array.`
  }

  return `${prompt}\n\n${CLASSIFICATION_RESULT_INSTRUCTIONS}`
}
