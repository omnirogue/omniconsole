import type { JsonSchema } from './json-schema-validate'
import {
  WORKFLOW_FROZEN_EVIDENCE_INSTRUCTIONS,
  workflowAgentInstructions,
  type WorkflowAgentAccess,
  type WorkflowAgentOutput
} from './workflow-agent-instructions'

export { WORKFLOW_FROZEN_EVIDENCE_INSTRUCTIONS }
export const WORKFLOW_GROK_POLICY_REVISION = 'grok-1.0.30-frozen-v1'
/**
 * Earlier releases of the same frozen argv: the working-agent release pinned Grok 1.0.40 exactly and
 * recorded this revision on its seats. Replays and follow-ups of those runs still accept it.
 */
export const WORKFLOW_GROK_PRIOR_POLICY_REVISIONS = ['grok-1.0.40-frozen-v1'] as const
/** Current-code Grok policy: real binary, private GROK_HOME, streamed output. */
export const WORKFLOW_GROK_WORKSPACE_POLICY_REVISION = 'grok-workspace-read-v1'
/** Grok's read-only built-ins (1.0.34): no write, edit, shell, web or MCP meta-tools. */
export const WORKFLOW_GROK_READ_TOOLS = ['read_file', 'grep', 'list_dir'] as const

// An empty toolConfig fails initialization; filtering the sole configured tool yields zero tools.
export const WORKFLOW_GROK_AGENT_PROFILE = `---
name: workflow-analysis
description: Independent analysis of frozen evidence
promptMode: full
agentsMd: false
discoverSkills: false
inheritSkills: false
injectDefaultTools: false
mcpInheritance: none
toolConfig: { tools: [{ id: "GrokBuild:read_file" }] }
tools: [read_file]
userMessageTemplate: ""
---
${WORKFLOW_FROZEN_EVIDENCE_INSTRUCTIONS}
`

/** Session overrides; the caller retains the selected account and mandatory policy layers. */
export function workflowGrokEnvironment(): Record<string, string> {
  return {
    GROK_WORKFLOWS: '0',
    GROK_MEMORY: '0',
    GROK_CLAUDE_MCPS_ENABLED: '0',
    GROK_CURSOR_MCPS_ENABLED: '0',
    GROK_CLAUDE_HOOKS_ENABLED: '0',
    GROK_CURSOR_HOOKS_ENABLED: '0',
    GROK_CLAUDE_SKILLS_ENABLED: '0',
    GROK_CURSOR_SKILLS_ENABLED: '0',
    GROK_CLAUDE_AGENTS_ENABLED: '0',
    GROK_CURSOR_AGENTS_ENABLED: '0',
    GROK_CLAUDE_RULES_ENABLED: '0',
    GROK_CURSOR_RULES_ENABLED: '0'
  }
}

/** Write only in a private attempt workspace, using host-discovered server names. */
export function buildWorkflowGrokProjectConfig(
  mcpServerNames: readonly string[],
  skillNames: readonly string[] = []
): string {
  const servers = [...new Set(mcpServerNames)]
    .sort()
    .map((name) => {
      if (
        !name.trim() ||
        [...name].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )
      ) {
        throw new Error('Invalid discovered Grok MCP server name')
      }
      // Grok discards incomplete disabled entries before merging project overrides.
      return `[mcp_servers.${JSON.stringify(name)}]\nenabled = false\nurl = "http://127.0.0.1:9/workflow-disabled"\n`
    })
    .join('\n')
  const skills = [...new Set(skillNames)].sort()
  if (
    skills.some(
      (name) =>
        !name.trim() ||
        [...name].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )
    )
  ) {
    throw new Error('Invalid discovered Grok skill name')
  }
  return servers + (skills.length ? `\n[skills]\ndisabled = ${JSON.stringify(skills)}\n` : '')
}

function assertGrokInput(input: {
  model: string
  effort?: string
  attemptId: string
  profilePath: string
  promptPath: string
}): void {
  if (
    !input.model.trim() ||
    !input.profilePath.trim() ||
    !input.promptPath.trim() ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.attemptId) ||
    (input.effort !== undefined && !input.effort.trim())
  ) {
    throw new Error('Resolved Grok model, effort, attempt identity and input paths required')
  }
}

/** Restricts model tools; host admission must separately verify hooks, memory and effective config. */
export function buildWorkflowGrokArgs(input: {
  model: string
  effort?: string
  attemptId: string
  schema: JsonSchema
  profilePath: string
  promptPath: string
}): string[] {
  assertGrokInput(input)
  return [
    '--agent',
    input.profilePath,
    '--prompt-file',
    input.promptPath,
    '--model',
    input.model,
    ...(input.effort ? ['--reasoning-effort', input.effort] : []),
    '--tools',
    'read_file',
    '--disallowed-tools',
    'read_file',
    '--no-subagents',
    '--disable-web-search',
    '--permission-mode',
    'dontAsk',
    '--max-turns',
    '1',
    '--json-schema',
    JSON.stringify(input.schema),
    '--system-prompt-override',
    WORKFLOW_FROZEN_EVIDENCE_INSTRUCTIONS,
    '--session-id',
    input.attemptId
  ]
}

/** Agent profile for streamed launches: the read tools in workspace-read, none when frozen. */
export function workflowGrokStreamProfile(
  access: WorkflowAgentAccess,
  output: WorkflowAgentOutput
): string {
  // Frozen keeps the legacy trick: the sole configured tool is removed by --disallowed-tools.
  const tools = access === 'workspace-read' ? WORKFLOW_GROK_READ_TOOLS : (['read_file'] as const)
  return `---
name: workflow-analysis
description: ${access === 'workspace-read' ? 'Read-only workspace analysis' : 'Independent analysis'}
promptMode: full
agentsMd: false
discoverSkills: false
inheritSkills: false
injectDefaultTools: false
mcpInheritance: none
toolConfig: { tools: [${tools.map((id) => `{ id: "GrokBuild:${id}" }`).join(', ')}] }
tools: [${tools.join(', ')}]
userMessageTemplate: ""
---
${workflowAgentInstructions(access, output)}
`
}

/** The custom sandbox profile streamed launches run under, defined in the private GROK_HOME. */
export const WORKFLOW_GROK_SANDBOX_PROFILE = 'omni-workflow'

/**
 * sandbox.toml for the private GROK_HOME (verified on 1.0.34, 2026-09-21). `read-only` still lets
 * read_file open any path on disk; `strict` limits reads to the working directory and system
 * paths, and these grants add the attempt folder and the account home the login is linked from.
 * Denied paths are kernel-enforced for Grok's own tools too. An unusable profile stops Grok.
 */
export function buildWorkflowGrokSandboxConfig(input: {
  readOnly: readonly string[]
  readWrite: readonly string[]
  deny: readonly string[]
}): string {
  const paths = [...input.readOnly, ...input.readWrite, ...input.deny]
  const control = (path: string) =>
    [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  if (paths.some((path) => !path.startsWith('/') || control(path))) {
    throw new Error('Grok sandbox paths must be absolute')
  }
  return [
    `[profiles.${WORKFLOW_GROK_SANDBOX_PROFILE}]`,
    'extends = "strict"',
    `read_only = ${JSON.stringify(input.readOnly)}`,
    `read_write = ${JSON.stringify(input.readWrite)}`,
    `deny = ${JSON.stringify(input.deny)}`,
    ''
  ].join('\n')
}

/**
 * Streamed Grok command (verified on 1.0.34, 2026-09-21). Project config and session storage
 * follow `--cwd`, so the caller runs the real binary with a private GROK_HOME and never writes
 * `.grok/` into the workspace. Without a schema the answer is the text after the last tool call.
 */
export function buildWorkflowGrokStreamArgs(input: {
  model: string
  effort?: string
  attemptId: string
  profilePath: string
  promptPath: string
  /** The workspace root for workspace-read; an empty private folder when frozen. */
  cwd: string
  access: WorkflowAgentAccess
  schema?: JsonSchema
}): string[] {
  assertGrokInput(input)
  if (!input.cwd.trim()) {
    throw new Error('Grok workflow working directory required')
  }
  const workspace = input.access === 'workspace-read'
  return [
    '--agent',
    input.profilePath,
    '--prompt-file',
    input.promptPath,
    '--cwd',
    input.cwd,
    '--model',
    input.model,
    ...(input.effort ? ['--reasoning-effort', input.effort] : []),
    '--tools',
    workspace ? WORKFLOW_GROK_READ_TOOLS.join(',') : 'read_file',
    ...(workspace ? [] : ['--disallowed-tools', 'read_file']),
    '--no-subagents',
    '--disable-web-search',
    '--permission-mode',
    'dontAsk',
    '--sandbox',
    WORKFLOW_GROK_SANDBOX_PROFILE,
    // Reading a workspace takes several model rounds (list, read, answer); frozen answers take one.
    '--max-turns',
    workspace ? '24' : '1',
    '--output-format',
    'streaming-json',
    ...(input.schema ? ['--json-schema', JSON.stringify(input.schema)] : []),
    '--system-prompt-override',
    workflowAgentInstructions(input.access, input.schema ? 'schema' : 'text'),
    '--session-id',
    input.attemptId
  ]
}

// Tables that would bring back MCP servers, memory, workflows, hooks, plugin sources or skills.
const PRIVATE_HOME_DROPPED_TABLES = new Set([
  'mcp_servers',
  'memory',
  'workflows',
  'skills',
  'hooks',
  'marketplace',
  'plugins'
])

function tomlRootKey(path: string): string {
  const trimmed = path.trim()
  const quote = trimmed[0]
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1)
    return end > 0 ? trimmed.slice(1, end) : trimmed
  }
  return trimmed.split('.')[0].trim()
}

/**
 * config.toml for a private per-attempt GROK_HOME: the account's own settings without the tables
 * above, plus every discovered skill disabled (skills otherwise arrive as an injected reminder).
 */
export function buildWorkflowGrokHomeConfig(
  accountConfig: string,
  skillNames: readonly string[] = []
): string {
  let section: 'root' | 'keep' | 'drop' = 'root'
  const kept = accountConfig.split('\n').filter((line) => {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line)
    if (header) {
      section = PRIVATE_HOME_DROPPED_TABLES.has(tomlRootKey(header[1])) ? 'drop' : 'keep'
      return section === 'keep'
    }
    if (section === 'drop') {
      return false
    }
    const key = section === 'root' ? /^\s*([A-Za-z0-9_-]+|"[^"]*")\s*[.=]/.exec(line) : null
    return !key || !PRIVATE_HOME_DROPPED_TABLES.has(tomlRootKey(key[1]))
  })
  const base = kept.join('\n').trim()
  return (base ? `${base}\n` : '') + buildWorkflowGrokProjectConfig([], skillNames)
}
