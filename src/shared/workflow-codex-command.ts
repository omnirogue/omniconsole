import { workflowCliVersionAtLeast } from './workflow-cli-version'

const DISABLED_WORKFLOW_FEATURES = [
  'apps',
  'plugins',
  'remote_plugin',
  'hooks',
  'multi_agent',
  'browser_use',
  'computer_use',
  'image_generation',
  'view_image',
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'goals',
  'sleep_tool',
  'skill_search',
  'memories'
]

// Workspace reads run through Codex's shell under the read-only sandbox, so only those two stay on.
const WORKSPACE_DISABLED_FEATURES = DISABLED_WORKFLOW_FEATURES.filter(
  (name) => name !== 'shell_tool' && name !== 'unified_exec'
)
/** The named permission profile workspace-read launches select instead of `-s read-only`. */
export const WORKFLOW_CODEX_PERMISSION_PROFILE = 'workflow_read'

/**
 * Codex's read-only sandbox reads the whole disk, and its login shell sources the user's startup
 * files (which may export tokens). The profile keeps read-only and additionally denies the hidden
 * paths; the workspace stays readable as the more specific rule. A non-login shell skips the
 * startup files (verified on 0.155.1: `/bin/zsh -c`, secrets denied, sandbox_policy read-only).
 */
function workspacePermissionArgs(root: string, hidden: readonly string[]): string[] {
  const entries = new Map<string, 'deny' | 'read'>()
  for (const path of hidden) {
    entries.set(path, 'deny')
  }
  entries.set(root, 'read')
  const table = [...entries]
    .map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`)
    .join(',')
  const profile = WORKFLOW_CODEX_PERMISSION_PROFILE
  return [
    '-c',
    'allow_login_shell=false',
    '-c',
    `default_permissions=${JSON.stringify(profile)}`,
    '-c',
    `permissions.${profile}.extends=":read-only"`,
    '-c',
    `permissions.${profile}.filesystem={${table}}`
  ]
}

export const WORKFLOW_CODEX_POLICY_REVISION = 'codex-0.155.1-frozen-v1'
/** Current-code Codex policy for streamed and workspace-read launches. */
export const WORKFLOW_CODEX_WORKSPACE_POLICY_REVISION = 'codex-workspace-read-v1'

/** Requires a private operation home with account/policy references prepared by the host. */
export function buildWorkflowCodexArgs(input: {
  model: string
  effort: string
  schemaPath: string
  instructionsPath: string
}): string[] {
  if (Object.values(input).some((value) => !value.trim())) {
    throw new Error('Resolved Codex model, effort and frozen input paths required')
  }
  return [
    'exec',
    '--ignore-user-config',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    '--model',
    input.model,
    ...DISABLED_WORKFLOW_FEATURES.flatMap((name) => ['--disable', name]),
    '-c',
    'agents.enabled=false',
    '-c',
    'skills.include_instructions=false',
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    'web_search="disabled"',
    '-c',
    `model_reasoning_effort=${JSON.stringify(input.effort)}`,
    '-c',
    `model_instructions_file=${JSON.stringify(input.instructionsPath)}`,
    '--output-schema',
    input.schemaPath,
    '--json',
    '-'
  ]
}

/**
 * Current-workflow Codex command (verified on 0.155.1, 2026-09-21). With `workspaceRoot` the model
 * may run read-only shell commands there (`-C`) but never read `hiddenPaths`; without it, shell
 * stays disabled. Reasoning summaries feed the live view. Without `schemaPath` the last agent
 * message is a Markdown answer.
 */
export function buildWorkflowCodexStreamArgs(input: {
  model: string
  effort: string
  instructionsPath: string
  schemaPath?: string
  workspaceRoot?: string
  hiddenPaths?: readonly string[]
}): string[] {
  const { hiddenPaths = [], ...paths } = input
  if (
    Object.values(paths).some((value) => value !== undefined && !value.trim()) ||
    hiddenPaths.some((path) => !path.startsWith('/'))
  ) {
    throw new Error('Resolved Codex model, effort and private input paths required')
  }
  const root = input.workspaceRoot
  return [
    'exec',
    '--ignore-user-config',
    '--skip-git-repo-check',
    // A permission profile and `-s` cannot both be set; the profile extends read-only.
    ...(root ? ['-C', root] : ['-s', 'read-only']),
    '--model',
    input.model,
    ...(root ? WORKSPACE_DISABLED_FEATURES : DISABLED_WORKFLOW_FEATURES).flatMap((name) => [
      '--disable',
      name
    ]),
    '-c',
    'agents.enabled=false',
    '-c',
    'skills.include_instructions=false',
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    'web_search="disabled"',
    '-c',
    `model_reasoning_effort=${JSON.stringify(input.effort)}`,
    '-c',
    'model_reasoning_summary="concise"',
    ...(root ? workspacePermissionArgs(root, hiddenPaths) : []),
    '-c',
    `model_instructions_file=${JSON.stringify(input.instructionsPath)}`,
    ...(input.schemaPath ? ['--output-schema', input.schemaPath] : []),
    '--json',
    '-'
  ]
}

/**
 * Native exec JSON omits configured model/effort; the attempt-bound rollout retains them.
 * `expected.cliVersion` is the oldest accepted CLI; the result reports the rollout's own version.
 */
export function parseWorkflowCodexSessionEvidence(
  raw: string,
  expected: { sessionId: string; model: string; effort: string; cliVersion: string }
): { sessionId: string; turnId: string; model: string; effort: string; cliVersion: string } {
  const rows: { type: string; payload: Record<string, unknown> }[] = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const metadata = rows.filter((row) => row.type === 'session_meta')
  const contexts = rows.filter((row) => row.type === 'turn_context')
  if (metadata.length !== 1 || contexts.length !== 1) {
    throw new Error('Codex did not record exactly one session and turn for this answer.')
  }
  const meta = metadata[0].payload
  const context = contexts[0].payload
  // Newer CLIs also record the effective permission profile; it may deny but never grant writes.
  const permissions = context.permission_profile as
    | { file_system?: { entries?: { access?: unknown }[] } }
    | undefined
  const entries = permissions?.file_system?.entries
  const grantsWrite =
    entries !== undefined &&
    (!Array.isArray(entries) || entries.some((entry) => entry?.access === 'write'))
  if (
    grantsWrite ||
    meta.id !== expected.sessionId ||
    meta.session_id !== expected.sessionId ||
    typeof meta.cli_version !== 'string' ||
    !workflowCliVersionAtLeast(meta.cli_version, expected.cliVersion) ||
    meta.originator !== 'codex_exec' ||
    meta.model_provider !== 'openai' ||
    context.model !== expected.model ||
    context.effort !== expected.effort ||
    typeof context.turn_id !== 'string' ||
    !context.turn_id ||
    context.approval_policy !== 'never' ||
    !context.sandbox_policy ||
    typeof context.sandbox_policy !== 'object' ||
    (context.sandbox_policy as { type?: string }).type !== 'read-only'
  ) {
    throw new Error('Codex ran with a different model, effort or sandbox than this run chose.')
  }
  return {
    sessionId: expected.sessionId,
    turnId: context.turn_id,
    model: expected.model,
    effort: expected.effort,
    cliVersion: meta.cli_version
  }
}
