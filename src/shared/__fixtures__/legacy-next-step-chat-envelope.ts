import { legacyNextStepChatFilingGuide } from '../next-step-chat-submission'

const CONTEXT_MARKER = '\n\nAdditional task context (context only, not the user request):\n'

/**
 * The native-chat envelope builds before 2026-09-21 wrote around a typed next-step request.
 * Nothing produces it any more; tests use it to prove persisted transcripts still decode.
 */
export function legacyNextStepChatEnvelope(
  sourcePrompt: string,
  options: { cli?: string; context?: string } = {}
): string {
  const guide = options.cli ? `\n\n${legacyNextStepChatFilingGuide(options.cli)}` : ''
  const context = options.context ? `${CONTEXT_MARKER}${options.context}` : ''
  return `<!-- omni-outcome-source-v1 -->\n<!-- omni-next-step-chat-v1:${sourcePrompt.length} -->\n${sourcePrompt}${guide}${context}`
}
