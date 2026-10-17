import { readCodexSessionOptionsFromTerminalScreen } from './codex-terminal-session-options'
import { stripScrollbackAnsi } from './native-chat-scrape-fallback'

export type ObservedValues = { model: string; effort: string }

const EFFORT = '(?:minimal|low|medium|high|xhigh|max|ultra)'
const FOOTER_LINE = new RegExp(`^[\\w.-]+\\s+${EFFORT}\\s+·\\s+(?:~|\\/|[A-Za-z]:[\\\\/])`)
const HEADER_VALUES = new RegExp(`^([\\w.-]+)\\s+(${EFFORT})(?:\\s|$)`)

function parseHeaderValues(line: string): ObservedValues | null {
  const match = HEADER_VALUES.exec(line)
  return match ? { model: match[1]!, effort: match[2]! } : null
}

/**
 * The resumed process paints its startup box (`>_ OpenAI Codex … model: …`)
 * before anything else, then replays the transcript. Read the FIRST box in the
 * live bytes; only when none is there yet fall back to the first footer line.
 * A box whose model is still `loading` yields null so the caller keeps polling.
 */
export function readLiveStartupHeader(liveText: string): ObservedValues | null {
  const lines = stripScrollbackAnsi(liveText)
    .split('\n')
    .map((line) => line.trim())
  const box = lines.findIndex((line) => /^│\s*>_ OpenAI Codex\b/.test(line))
  if (box !== -1) {
    // Why every later model line: the box first says `model: loading` and Codex
    // repaints that row in place, which the raw stream carries as another line.
    for (const line of lines.slice(box + 1)) {
      if (/^│\s*model:/.test(line)) {
        const values = parseHeaderValues(line.replace(/^│\s*model:\s*/, ''))
        if (values) {
          return values
        }
      }
    }
    return null
  }
  const footer = lines.find((line) => FOOTER_LINE.test(line))
  return footer ? parseHeaderValues(footer) : null
}

/** The whole-buffer read the option pickers use (last footer or framed header). */
export function scrapeCodexHeader(screen: string | null | undefined): ObservedValues | null {
  const values = readCodexSessionOptionsFromTerminalScreen(screen)
  return values && typeof values.model === 'string' && typeof values.effort === 'string'
    ? { model: values.model, effort: values.effort }
    : null
}
