import { parseAskFromStatus } from '../../shared/native-chat-ask'

/** Normalize only the hook-bound single-choice menu's known Claude chrome. */
export function normalizeClaudeSingleQuestionMenu(
  lines: string[],
  hook: string | null | undefined
): string[] | null {
  const prompt = parseAskFromStatus(hook)
  const question = prompt?.questions[0]
  if (
    !question?.header ||
    prompt?.delivery === 'async' ||
    prompt?.questions.length !== 1 ||
    question.multiSelect ||
    question.options.some((option) => option.preview) ||
    lines.at(-1)?.trim() !== 'Enter to select · ↑/↓ to navigate · Esc to cancel'
  ) {
    return null
  }
  const count = question.options.length
  if (
    lines.at(-4)?.trim() !== `${count + 1}. Type something.` ||
    !/^─{3,}$/.test(lines.at(-3)?.trim() ?? '') ||
    lines.at(-2)?.trim() !== `${count + 2}. Chat about this`
  ) {
    return null
  }
  const header = lines.findLastIndex((line) => line.trim() === `☐ ${question.header}`)
  const optionStart = lines.findIndex((line) => /^\s*[❯›>]?\s*1\.\s/.test(line))
  if (
    header === -1 ||
    header >= optionStart ||
    lines.slice(0, optionStart).some((line, index) => index !== header && /[☐☒☑]/.test(line))
  ) {
    return null
  }
  const normalized = [...lines.slice(0, -4), lines.at(-1)!]
  normalized[header] = question.header
  return normalized
}
