/**
 * Titles that name a launcher, a harness or an id instead of the work, such as
 * `worker-task_5ad8df40da3a` or `claude conversation`. Such a title says nothing about the session,
 * so the sidebar may show the session's goal instead, and `session tidy` flags it.
 */
const JUNK_SESSION_TITLE_PATTERNS: readonly RegExp[] = [
  /^worker-task[_-][0-9a-f]{6,}$/i,
  /^(claude|codex|grok|gemini|opencode|kimi|cursor)( code| cli)? (conversation|session|chat)$/i,
  /^ssh-\d{6,}\S*$/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{12,}$/i
]

export function isJunkSessionTitle(title: string | null | undefined): boolean {
  const trimmed = title?.trim()
  if (!trimmed) {
    return false
  }
  return JUNK_SESSION_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed))
}
