/**
 * Keep the startup detector tolerant of wrapped prompts and provider-specific trust banners.
 * A later ordinary composer retires the signal: narration about a past dialog cannot keep a
 * completed conversation waiting for permission.
 */
export function findWorkspaceTrustPromptIndex(text: string): number | null {
  const normalized = text.toLowerCase()
  const found = Math.max(
    normalized.lastIndexOf('do you trust'),
    normalized.lastIndexOf('trust this'),
    normalized.lastIndexOf('trusted workspace')
  )
  if (found === -1 || !/workspace|folder|directory|repo/.test(normalized.slice(found))) {
    return null
  }
  const composer = findTerminalComposerIndex(text)
  return composer !== null && composer > found ? null : found
}

/** A composer can appear while busy: it dismisses startup UI but does not prove idle. */
export function findTerminalComposerIndex(text: string): number | null {
  const lines = text.split('\n')
  let offset = 0
  let found: number | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    const claude =
      line === '❯' &&
      /^─{3,}/.test(lines[index - 1]?.trim() ?? '') &&
      /^─{3,}/.test(lines[index + 1]?.trim() ?? '')
    const codex =
      /^›\s*ask codex to do anything$/i.test(line) &&
      /^gpt-[\w.-]+\s+\w+\s*·/i.test(lines[index + 1]?.trim() ?? '')
    if (claude || codex) {
      found = offset
    }
    offset += lines[index]!.length + 1
  }
  return found
}
