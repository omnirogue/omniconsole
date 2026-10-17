import type { AskAnswerKeyGroup, AskAnswerSelection, AskPrompt } from './native-chat-ask'

/** OMP's rich ask dialog uses arrows/Space/Enter; pasted labels and digits do not select. */
export function buildOmpAskAnswerKeys(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerKeyGroup[] {
  const groups: AskAnswerKeyGroup[] = []
  const multipleQuestions = prompt.questions.length > 1
  let endsOnSubmit = multipleQuestions

  prompt.questions.forEach((question, questionIndex) => {
    const selection = selections[questionIndex]
    const indices = [...new Set(selection?.indices ?? [])].filter(
      (index) => Number.isInteger(index) && index >= 0 && index < question.options.length
    )
    const other = selection?.other?.trim()
    let cursor: number | undefined
    const moveTo = (index: number): void => {
      if (cursor === undefined) {
        // Up clamps: ignore the recommendation and any earlier terminal row navigation.
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
      moveTo(question.options.length)
      const labels = question.multiSelect
        ? []
        : indices.map((index) => question.options[index]!.label)
      groups.push({ raw: '\r' }, { text: [...labels, other].join(', ') }, { raw: '\r' })
      // A lone multi-select with custom input returns to the Submit tab.
      endsOnSubmit ||= question.multiSelect
    } else if (indices.length > 0) {
      if (!question.multiSelect) {
        moveTo(indices[0]!)
      }
      groups.push({ raw: '\r' })
    } else if (multipleQuestions) {
      groups.push({ raw: '\x1b[C' })
    }
  })

  if (groups.length > 0 && endsOnSubmit) {
    groups.push({ raw: '\r' })
  }
  return groups
}
