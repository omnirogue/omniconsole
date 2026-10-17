// Short Codex replies omit “Worked for”: the assistant body is followed by a clock,
// a ready composer and the model footer. The clock alone is ordinary transcript text.
import {
  remapTerminalScreenDecorations,
  type TerminalScreenDecoration
} from '../../shared/terminal-codex-recap'
const CLOCK = /^(?:[A-Z][a-z]{2} \d{1,2} at )?\d{1,2}:\d{2}\s*[AP]M$/i
const COMPOSER = /^›\s*Ask Codex to do anything$/
const MODEL_FOOTER = /^(?:gpt|o\d|codex)[\w.-]*(?:\s+[\w.-]+)*\s+·\s+\S/i
const BORDER = /^[─━═│┃┌┐└┘┏┓┗┛╭╮╰╯┬┴┼╞╡╪╫╔╗╚╝╠╣╦╩╬]+$/u

/** `reply` must come from the same live Codex process's current completed turn. */
export function hasCodexShortCompletion(
  status: readonly string[],
  reply?: string | null,
  screenDecorations?: readonly TerminalScreenDecoration[]
): boolean {
  if (!reply?.trim() || reply.length > 4096) {
    return false
  }
  const retainedRows = status.flatMap((line, row) => (BORDER.test(line) ? [] : [row]))
  const lines = retainedRows.map((row) => status[row])
  const decorations = remapTerminalScreenDecorations(screenDecorations, retainedRows)
  if (/^\? for shortcuts\b/.test(lines.at(-1) ?? '')) {
    lines.pop()
  }
  const footer = lines.at(-1)
  if (!footer || !MODEL_FOOTER.test(footer) || !COMPOSER.test(lines.at(-2) ?? '')) {
    return false
  }
  let clockIndex = lines.length - 3
  if (/^Tip:\s/.test(lines[clockIndex] ?? '')) {
    clockIndex -= 1
  }
  // Only the styled closing history cell may intervene; older recaps keep their own indexes.
  const closingRecaps = decorations.filter((decoration) => decoration.endRow === clockIndex)
  if (closingRecaps.length === 1) {
    const recap = closingRecaps[0]
    if (/^↳ Recap:\s+\S/.test(lines[recap.startRow] ?? '')) {
      clockIndex = recap.startRow - 1
    }
  }
  if (!CLOCK.test(lines[clockIndex] ?? '')) {
    return false
  }
  // Only the latest assistant block can close this turn. A later submitted prompt,
  // tool output, menu, or text after the clock cannot be mistaken for its composer.
  let assistantIndex = clockIndex - 1
  while (assistantIndex >= 0 && !lines[assistantIndex].startsWith('• ')) {
    assistantIndex -= 1
  }
  if (assistantIndex < 0) {
    return false
  }
  const body = lines.slice(assistantIndex, clockIndex)
  if (body.some((line) => /^[›❯]/.test(line))) {
    return false
  }
  const rendered = body
    .join(' ')
    .replace(/^•\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return rendered === reply.replace(/\s+/g, ' ').trim()
}
