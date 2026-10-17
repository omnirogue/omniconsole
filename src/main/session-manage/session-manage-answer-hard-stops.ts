import { refuseHardStop, SessionManageRefusal } from './session-manage-refusal'
import type { SessionPrompt } from './session-prompt'
import { destructiveLiteralCommand } from './session-answer-command-hard-stops'
import { adPausesFor, type AdPauseTarget } from '../next-steps/next-step-ad-pause-policy'
import { hardStopOf } from '../next-steps/next-step-keep-going-hard-stops'

/**
 * On top of the Keep going list: relative paths and implicit branch targets cannot be proved safe
 * from prompt text, and merges and history rewrites are named outright.
 */
const ANSWER_HARD_STOPS: readonly RegExp[] = [
  /\b(?:rm|unlink|rmdir|Remove-Item|del|erase)\b|\b(?:os\.remove|shutil\.rmtree)\b/i,
  /\b(?:git|glab)\b[^\n]*\b(?:push|merge)\b/i,
  /\bgh\s+pr\s+merge\b/i,
  /\bgit\b[^\n]*\breset\s+--hard\b/i,
  /\bgit\b[^\n]*\brebase\b/i,
  /\bgit\b[^\n]*\bfilter-(?:repo|branch)\b/i,
  /\bgit\b[^\n]*\bpush\b[^\n]*(?:\s--force(?:-with-lease)?\b|\s-f\b|\s\+\S)/i
]

export function answerHardStop(text: string, target?: AdPauseTarget): boolean {
  const matchesAnswerStop = (value: string) => {
    const joined = value.replace(/\s+/g, ' ')
    return ANSWER_HARD_STOPS.some((pattern) => pattern.test(joined))
  }
  return (
    destructiveLiteralCommand(
      text,
      (canonical) =>
        matchesAnswerStop(canonical) || hardStopOf(canonical, adPausesFor(target)) !== null
    ) || matchesAnswerStop(text)
  )
}

function checkAnswerHardStops(text: string, target?: AdPauseTarget): void {
  refuseHardStop(text, target)
  if (answerHardStop(text, target)) {
    throw new SessionManageRefusal(
      'Refused (hard stop): file deletion, a push or merge, or a history rewrite needs the person. Nothing was sent.'
    )
  }
}

/**
 * Every text the answer could approve or send, each classified on its own: the prompt as shown,
 * each command source (the agent's hook report, the screen's command block, the structured
 * detail), and the chosen option or reply.
 */
export function checkPromptHardStops(
  prompt: SessionPrompt,
  answered: string,
  target?: AdPauseTarget
): void {
  for (const text of [prompt.ask.text, ...prompt.commandText, answered]) {
    checkAnswerHardStops(text, target)
  }
}
