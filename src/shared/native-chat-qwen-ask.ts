import type { AskAnswerKeyGroup, AskAnswerSelection } from './native-chat-ask'
import type { AskPrompt } from './native-chat-ask-types'
import { optionOnlyAnswerIndices } from './native-chat-option-only-ask'

/**
 * Qwen Code's ask_user_question dialog. Single-select: a digit picks and advances (a lone
 * question submits). Multi-select: a digit only moves to that row, Space toggles, Enter confirms.
 * A batch ends on a Submit tab with "Submit answers" highlighted, so one Enter submits. Nothing
 * after that: Qwen's empty composer shows a ghost suggestion a stray Enter would send.
 */
export function buildQwenAskAnswerKeys(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerKeyGroup[] {
  const answers = optionOnlyAnswerIndices(prompt, selections, { allowMultiSelect: true })
  if (!answers) {
    return []
  }
  const groups: AskAnswerKeyGroup[] = []
  answers.forEach((indices, screen) => {
    if (!prompt.questions[screen]!.multiSelect) {
      groups.push({ raw: String(indices[0]! + 1), screen })
      return
    }
    for (const index of indices) {
      groups.push({ raw: String(index + 1), screen }, { raw: ' ', screen })
    }
    groups.push({ raw: '\r', screen })
  })
  if (answers.length > 1) {
    groups.push({ raw: '\r', screen: 'submit' })
  }
  return groups
}
