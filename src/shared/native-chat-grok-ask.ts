import type { AskAnswerKeyGroup, AskAnswerSelection, AskPrompt } from './native-chat-ask'

/** Grok's question card selects with Enter and submits on the last question. */
export function buildGrokAskAnswerKeys(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerKeyGroup[] {
  const groups: AskAnswerKeyGroup[] = []
  prompt.questions.forEach((question, questionIndex) => {
    const selection = selections[questionIndex]
    const indices = [...new Set(selection?.indices ?? [])].filter(
      (index) => Number.isInteger(index) && index >= 0 && index < question.options.length
    )
    const other = selection?.other?.trim()
    let cursor: number | undefined
    const moveTo = (index: number): void => {
      if (cursor === undefined) {
        // Up clamps, including when the native cursor was moved before opening Chat.
        for (let step = 0; step < question.options.length; step += 1) {
          groups.push({ raw: '\x1b[A' })
        }
        cursor = 0
      }
      const key = index > cursor ? '\x1b[B' : '\x1b[A'
      for (let step = 0; step < Math.abs(index - cursor); step += 1) {
        groups.push({ raw: key })
      }
      cursor = index
    }

    if (question.multiSelect) {
      for (const index of indices) {
        moveTo(index)
        groups.push({ raw: ' ' })
      }
    }
    if (other) {
      const labels = question.multiSelect
        ? []
        : indices.map((index) => question.options[index]!.label)
      groups.push({ raw: 'z' }, { text: [...labels, other].join(', ') }, { raw: '\r' })
    } else if (indices.length > 0) {
      if (!question.multiSelect) {
        moveTo(indices[0]!)
      }
      groups.push({ raw: '\r' })
    } else if (prompt.questions.length > 1) {
      // Grok Right changes questions; Tab only cycles answers within this question.
      groups.push({ raw: '\x1b[C' })
    }
  })
  return groups
}
