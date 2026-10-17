// Why: an app relaunched from inside one of its own terminals (an installer or `pnpm dev` run by
// an agent in a pane) inherits that pane's identity. Every child the main process then spawns
// with process.env — the hidden `claude /usage` probe above all — posts hooks as that pane, so a
// fresh provider session lands on it every few minutes and an archived row keeps coming back.
// The app owns no pane itself; each pane it launches gets its identity explicitly.
const INHERITED_PANE_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_WORKSPACE_ID',
  'ORCA_TERMINAL_HANDLE',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENDPOINT',
  'ORCA_AGENT_HOOK_TRANSPORT'
] as const

export function clearInheritedPaneIdentityEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const cleared = INHERITED_PANE_ENV_KEYS.filter((key) => env[key] !== undefined)
  for (const key of cleared) {
    delete env[key]
  }
  return cleared
}
