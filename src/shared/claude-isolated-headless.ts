/**
 * Claude Code flags for a background one-shot that must not run the person's hooks, MCP
 * servers, plugins, settings files or slash commands, and keeps no transcript (verified on
 * 2.1.278, 2026-09-21). OAuth still works: this is not `--bare`. One recipe for workflow runs,
 * model-list probes, session summaries and the one-shot text runs (commit messages and the rest).
 */
export const CLAUDE_ISOLATED_HEADLESS_ARGS: readonly string[] = [
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--setting-sources',
  '',
  '--disable-slash-commands',
  '--no-session-persistence'
]

/** Skips the claude.ai MCP server fetch that `--strict-mcp-config` would discard anyway. */
export const CLAUDE_ISOLATED_HEADLESS_ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } as const

/** The recipe as flag groups (a flag and the values that follow it). */
function recipeGroups(): string[][] {
  const groups: string[][] = []
  for (const token of CLAUDE_ISOLATED_HEADLESS_ARGS) {
    if (token.startsWith('--')) {
      groups.push([token])
    } else {
      groups.at(-1)?.push(token)
    }
  }
  return groups
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))
}

/**
 * Appends the isolation recipe to a stdin-prompted Claude argv. A flag the person's own recipe
 * arguments already set wins and is not repeated. `noTools` also passes `--tools ''` for runs
 * whose prompt carries everything they need. `batchSafe` leaves out the inline JSON MCP config,
 * whose quotes a Windows `.cmd` shim refuses; `--strict-mcp-config` with no `--mcp-config` still
 * loads no MCP server at all.
 */
export function withClaudeIsolatedHeadlessArgs(
  args: readonly string[],
  options: { noTools: boolean; batchSafe?: boolean }
): string[] {
  const extra = recipeGroups().flatMap(([flag = '', ...values]) =>
    hasFlag(args, flag) || (options.batchSafe && flag === '--mcp-config') ? [] : [flag, ...values]
  )
  if (options.noTools && !hasFlag(args, '--tools')) {
    extra.push('--tools', '')
  }
  return [...args, ...extra]
}
