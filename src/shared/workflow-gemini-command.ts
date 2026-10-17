import type { JsonSchema } from './json-schema-validate'
import {
  workflowAgentInstructions,
  type WorkflowAgentAccess,
  type WorkflowAgentOutput
} from './workflow-agent-instructions'

/** Gemini answers and finds only; it never ranks, verifies or chairs (model-lineage.ts). */
export const WORKFLOW_GEMINI_POLICY_REVISION = 'gemini-readonly-v1'
export const WORKFLOW_GEMINI_READ_TOOLS = ['read_file', 'list_directory', 'glob', 'grep_search']
const DENIED_TOOLS = [
  'run_shell_command',
  'write_file',
  'replace',
  'web_fetch',
  'google_web_search',
  'save_memory',
  'write_todos',
  'activate_skill',
  'enter_plan_mode',
  'exit_plan_mode',
  'ask_user',
  'invoke_agent'
]

/** Admin-tier policy: a second layer behind tools.core that denies anything that writes or runs. */
export const WORKFLOW_GEMINI_ADMIN_POLICY = `[[rule]]
toolName = ${JSON.stringify(DENIED_TOOLS)}
decision = "deny"
priority = 900
denyMessage = "Read-only workflow seat: this tool is disabled."
`

/**
 * Model rounds before Gemini stops with exit 53. Reading a real area takes a round per batch of
 * tool calls, so workspace reads get room; the call's timeout still bounds the run.
 */
export function workflowGeminiMaxTurns(access: WorkflowAgentAccess | undefined): number {
  return access === 'workspace-read' ? 80 : 20
}

/** Workflow effort maps onto Gemini's thinking level; medium is the verified default. */
export function workflowGeminiThinkingLevel(effort: string | null | undefined): string {
  return effort === 'low' ? 'LOW' : effort === 'high' ? 'HIGH' : 'MEDIUM'
}

/**
 * Highest-precedence settings layer (verified on 0.59.0, 2026-09-21). dynamicModelConfiguration is
 * load-bearing: without it any "*flash" id is silently served by gemini-3.5-flash. The schema,
 * when present, rides on the model alias because the CLI has no schema flag.
 */
export function buildWorkflowGeminiSystemSettings(input: {
  model: string
  effort?: string | null
  schema?: JsonSchema
  access?: WorkflowAgentAccess
}): string {
  if (!input.model.trim()) {
    throw new Error('Resolved Gemini model required')
  }
  return JSON.stringify({
    security: {
      auth: { selectedType: 'gemini-api-key' },
      folderTrust: { enabled: false },
      disableYoloMode: true
    },
    general: {
      enableAutoUpdate: false,
      enableAutoUpdateNotification: false,
      checkpointing: { enabled: false }
    },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
    advanced: { ignoreLocalEnv: true },
    skills: { enabled: false },
    hooksConfig: { enabled: false },
    experimental: { enableAgents: false, dynamicModelConfiguration: true },
    admin: { mcp: { enabled: false }, extensions: { enabled: false }, skills: { enabled: false } },
    model: {
      maxSessionTurns: workflowGeminiMaxTurns(input.access),
      skipNextSpeakerCheck: true,
      disableLoopDetection: true
    },
    tools: { core: WORKFLOW_GEMINI_READ_TOOLS },
    modelConfigs: {
      customAliases: {
        [input.model]: {
          extends: 'chat-base-3',
          modelConfig: {
            model: input.model,
            generateContentConfig: {
              thinkingConfig: { thinkingLevel: workflowGeminiThinkingLevel(input.effort) },
              ...(input.schema
                ? { responseMimeType: 'application/json', responseJsonSchema: input.schema }
                : {})
            }
          }
        }
      }
    }
  })
}

/** Replaces Gemini's whole system prompt (GEMINI_SYSTEM_MD). */
export function workflowGeminiSystemPrompt(
  access: WorkflowAgentAccess,
  output: WorkflowAgentOutput
): string {
  return `${workflowAgentInstructions(access, output)}\n`
}

/** The prompt arrives on stdin; the CLI appends this `--prompt` text after it. */
export function buildWorkflowGeminiArgs(input: {
  model: string
  attemptId: string
  adminPolicyPath: string
}): string[] {
  if (
    !input.model.trim() ||
    !input.adminPolicyPath.trim() ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.attemptId)
  ) {
    throw new Error('Resolved Gemini model, attempt identity and policy path required')
  }
  return [
    '--model',
    input.model,
    '--output-format',
    'stream-json',
    '--approval-mode',
    'default',
    '--admin-policy',
    input.adminPolicyPath,
    '--extensions',
    'none',
    '--session-id',
    input.attemptId,
    '--prompt',
    'Complete the task above.'
  ]
}

/**
 * Private per-attempt environment. Everything Gemini would load from ~/.gemini (MCP servers,
 * hooks, skills, GEMINI.md, trusted folders) stays out; NO_RELAUNCH keeps a single process so a
 * timeout can terminate it. The caller adds the allowlisted basics and the account key.
 */
export function workflowGeminiEnvironment(paths: {
  home: string
  systemSettings: string
  systemDefaults: string
  systemPrompt: string
  tmp: string
}): Record<string, string> {
  return {
    GEMINI_CLI_HOME: paths.home,
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: paths.systemSettings,
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: paths.systemDefaults,
    GEMINI_CLI_TRUST_WORKSPACE: 'false',
    GEMINI_CLI_NO_RELAUNCH: 'true',
    GEMINI_SYSTEM_MD: paths.systemPrompt,
    NO_COLOR: '1',
    TMPDIR: paths.tmp
  }
}

/** GEMINI_API_KEY from a dotenv file (KEY=VALUE, optional `export`, quotes and comments). */
export function readWorkflowGeminiKey(dotenv: string): string | undefined {
  for (const raw of dotenv.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '')
    const separator = line.indexOf('=')
    if (
      line.startsWith('#') ||
      separator < 1 ||
      line.slice(0, separator).trim() !== 'GEMINI_API_KEY'
    ) {
      continue
    }
    const value = line.slice(separator + 1).trim()
    const quote = value[0]
    // A quoted value ends at its closing quote; an inline comment may follow it.
    const close = quote === '"' || quote === "'" ? value.indexOf(quote, 1) : -1
    return (close > 0 ? value.slice(1, close) : value.replace(/\s+#.*$/, '')).trim() || undefined
  }
  return undefined
}
