/**
 * Terminal "chrome": the Codex/Claude TUI furniture a PTY screen scrape carries but an
 * agent's own message never does — status footers, the resume-lock banner, key hints, the
 * launch box. A run whose recorded output is such a scrape (measured 2026-09-20 on the
 * local Advertising routine: 89,906 chars of Codex screen text) must never be rendered or
 * parsed as if it were the agent's report.
 */

/** Lines that only a Codex TUI screen contains; any one of them proves a scrape. */
const STRONG_CHROME_LINE_PATTERNS: readonly RegExp[] = [
  /^■ Conversation interrupted\b/,
  /This conversation is open in another app/,
  /\bR to Retry\b/,
  /\br retry\s+esc\/ctrl\+c\/q exit\b/,
  /\bctrl\s*\+?\s*t transcript\b/,
  /^Worked for \d+\s?(?:h|m|s|min|sec)\b.*\bdone\b/,
  /› Ask Codex to do anything/,
  /│\s*>_ OpenAI Codex\b/
]

/** Weaker furniture, stripped from a scrape but never used to classify one. */
const WEAK_CHROME_LINE_PATTERNS: readonly RegExp[] = [
  /^[╭╮╰╯─│┃━┏┓┗┛\s]*$/,
  /^│\s*(?:model|directory|permissions):.*│?\s*$/,
  /^Resuming session…/,
  /^Tip: You can resume a previous conversation\b/,
  /^Earlier messages are available\b/,
  /\? for shortcuts\s*$/,
  /^%\s*$/,
  /^[\w.-]+@[\w.-]+\s+\S+\s+%(?:\s|$)/
]

function isStrongChromeLine(line: string): boolean {
  return STRONG_CHROME_LINE_PATTERNS.some((pattern) => pattern.test(line))
}

function isChromeLine(line: string): boolean {
  return isStrongChromeLine(line) || WEAK_CHROME_LINE_PATTERNS.some((pattern) => pattern.test(line))
}

/** True when the text is (or contains) a TUI screen scrape rather than an agent message. */
export function hasAutomationTerminalChrome(content: string): boolean {
  return content.split(/\r?\n/).some((line) => isStrongChromeLine(line.trim()))
}

/** The Codex banner shown when a resumed thread is still open in another pane or app. */
const CODEX_THREAD_LOCK_PATTERN =
  /This conversation is open in another app|\bR to Retry\b|^■ Conversation interrupted\b/m

/** Positive turn-in-flight chrome shared by screen and ownership-lock observation. */
export function hasTerminalWorkingMarker(line: string): boolean {
  return (
    /\besc to interrupt\b/i.test(line) ||
    /^•\s*Working \(/i.test(line) ||
    /^[^\w\s]\s+[A-Z][a-z]+ing…/i.test(line)
  )
}

/** Require the ownership banner and its retry key, not a generic interrupted-turn message. */
export function findCodexConversationLockIndex(content: string): number | null {
  const normalized = content.toLowerCase()
  const index = normalized.lastIndexOf('this conversation is open in another app')
  if (index === -1) {
    return null
  }
  const suffix = normalized.slice(index)
  if (suffix.split(/\r?\n/).some((line) => hasTerminalWorkingMarker(line.trim()))) {
    return null
  }
  return /\br to retry\b|\br retry\s+esc\/ctrl\+c\/q exit\b|press r to continue here/.test(suffix)
    ? index
    : null
}

/**
 * Why a sentence and not a boolean: the run history row and the dispatch fallback both need
 * to tell a person what the pane showed, in words, instead of leaking screen text.
 */
export function describeDeadAutomationTerminal(content: string): string | null {
  if (!CODEX_THREAD_LOCK_PATTERN.test(content)) {
    return null
  }
  return 'Codex could not continue in this pane: its conversation is open in another app or window (the pane showed "R to Retry"). Nothing was executed.'
}

/** Drops chrome lines (the zsh partial-line `%` rides on one of them), keeping the rest verbatim. */
export function stripAutomationTerminalChrome(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !isChromeLine(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
