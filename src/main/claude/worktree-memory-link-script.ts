/** Claude Code keys its persistent memory by session cwd (`~/.claude/projects/<cwd-slug>/memory`),
 *  so a Claude launched inside a linked git worktree starts with none of the memory the primary
 *  checkout accumulated. These POSIX lines run from the managed SessionStart hook and point the
 *  worktree's memory directory at the main checkout's, so every OmniConsole worktree agent carries
 *  the repo's memory. Best-effort and silent: never fails the hook, never touches a populated dir. */
export function buildPosixWorktreeMemoryLinkLines(): string[] {
  return [
    // Why: only OmniConsole worktree panes; a plain terminal keeps Claude's default layout.
    'if [ -n "$ORCA_WORKTREE_ID" ]; then',
    '  case "$payload" in',
    "    *'\"hook_event_name\":\"SessionStart\"'*)",
    '      omni_link_worktree_memory() {',
    '        top=$(git rev-parse --show-toplevel 2>/dev/null) || return 0',
    "        main=$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')",
    '        [ -n "$main" ] && [ "$main" != "$top" ] || return 0',
    '        cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    // Why: Claude Code's project slug replaces every non-alphanumeric char with "-".
    "        src=\"$cfg/projects/$(printf '%s' \"$main\" | sed 's/[^A-Za-z0-9]/-/g')/memory\"",
    "        dst=\"$cfg/projects/$(printf '%s' \"$top\" | sed 's/[^A-Za-z0-9]/-/g')/memory\"",
    '        [ "$src" = "$dst" ] && return 0',
    '        [ -L "$dst" ] && return 0',
    '        if [ -d "$dst" ] && [ -n "$(ls -A "$dst" 2>/dev/null)" ]; then return 0; fi',
    '        mkdir -p "$src" || return 0',
    '        rmdir "$dst" 2>/dev/null',
    '        [ -e "$dst" ] && return 0',
    '        mkdir -p "$(dirname "$dst")" && ln -s "$src" "$dst"',
    '      }',
    '      omni_link_worktree_memory >/dev/null 2>&1 || :',
    '      ;;',
    '  esac',
    'fi'
  ]
}
