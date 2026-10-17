import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'

/** The phrases of every known Claude and Codex menu footer, lower case and without whitespace. */
const FOOTER_PHRASES = [
  'esc to cancel',
  'press enter to confirm',
  'enter to select',
  'enter to submit'
].map((phrase) => phrase.replace(/\s+/g, ''))

/**
 * A known Claude or Codex menu footer is still on screen, however colored or wrapped: ANSI is
 * stripped and every whitespace run (a wrap included) removed before matching. Some prompt is up,
 * parsed or not.
 */
export function screenShowsPromptMenu(screen: string): boolean {
  const flat = stripAnsiEscapeSequences(screen).replace(/\s+/g, '').toLowerCase()
  return FOOTER_PHRASES.some((phrase) => flat.includes(phrase))
}
