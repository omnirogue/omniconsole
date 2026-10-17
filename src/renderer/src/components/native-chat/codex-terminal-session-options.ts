import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import type { ReportedSessionOptionValues } from '../../../../shared/native-chat-session-options'
import { stripScrollbackAnsi } from './native-chat-scrape-fallback'

/** Read Codex's own startup box/footer, never a remembered UI selection. */
export function readCodexSessionOptionsFromTerminalScreen(
  screen: string | null | undefined,
  models?: readonly CatalogModel[]
): ReportedSessionOptionValues | null {
  if (!screen) {
    return null
  }
  const lines = stripScrollbackAnsi(screen)
    .split('\n')
    .map((line) => line.trim())
  const header = lines.findIndex((line) => /^│\s*>_ OpenAI Codex\b/.test(line))
  const footer = lines
    .toReversed()
    .find((line) =>
      /^[\w.-]+\s+(?:default|minimal|low|medium|high|xhigh|max|ultra)\s+·\s+(?:~|\/|[A-Za-z]:[\\/])/.test(
        line
      )
    )
  const framed =
    header !== -1
      ? lines.slice(header + 1, header + 5).find((line) => /^│\s*model:/.test(line))
      : undefined
  const source = footer ?? framed?.replace(/^│\s*model:\s*/, '')
  const match = source?.match(
    /^([\w.-]+)\s+(default|minimal|low|medium|high|xhigh|max|ultra)(?:\s|$)/
  )
  if (!match || (models?.length && !models.some((model) => model.id === match[1]))) {
    return null
  }
  // `default` identifies the model, but does not name a concrete effort. Clear
  // any previously reported effort instead of showing it as this process's value.
  return { model: match[1]!, effort: match[2] === 'default' ? null : match[2]! }
}
