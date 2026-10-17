import { AGENT_TEMPLATE_DEFAULT_ID, findAgentTemplate, type AgentTemplate } from './agent-templates'

/**
 * The Local Ollama launcher route: OpenCode as the runner, a local Ollama server as the
 * model provider, an optional agent template layered on the workspace's own instructions.
 */

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434'
export const OPENCODE_OLLAMA_PROVIDER_ID = 'ollama'

export type OllamaInstalledModel = {
  /** The Ollama tag, e.g. `qwen3-coder:30b`. */
  name: string
  sizeBytes: number
  family?: string
  parameterSize?: string
  quantization?: string
  modifiedAt?: string
}

export type OllamaInventory =
  | { status: 'connected'; baseUrl: string; models: OllamaInstalledModel[] }
  | { status: 'disconnected'; baseUrl: string; message: string }

/** What a target launched with last: the agent template, and for Local Ollama the model tag. */
export type LaunchContextRemembered = { templateId: string; ollamaModel?: string }

/** Keyed by launch target: a worktree id, `folder:<id>`, or `*` for the Work root. Shared by every provider row. */
export type LaunchContextMemory = Record<string, LaunchContextRemembered>

export const LOCAL_OLLAMA_MEMORY_ROOT_KEY = '*'
const MAX_MEMORY_ENTRIES = 200
// Why: Ollama tags may be namespaced (`user/model:tag`, `hf.co/org/model:tag`); OpenCode's
// provider/model split takes the first slash, so the whole tag still rides behind `ollama/`.
const MODEL_TAG_PATTERN = /^[a-z0-9][\w.-]*(:\d+)?(\/[a-z0-9][\w.-]*)*(:[\w.-]+)?$/i

/** Ollama treats an untagged name as `:latest`; compare tags accordingly. */
export function sameOllamaTag(a: string, b: string): boolean {
  // Why: only a colon after the last slash is the tag; `host:5000/model` has none.
  const norm = (tag: string): string => {
    const name = tag.slice(tag.lastIndexOf('/') + 1)
    return name.includes(':') ? tag : `${tag}:latest`
  }
  return norm(a) === norm(b)
}

export function isOllamaModelTag(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 120 && MODEL_TAG_PATTERN.test(value)
}

/** OpenCode addresses a model as `provider/model`; the tag keeps its `:size` suffix. */
export function openCodeOllamaModelId(tag: string): string {
  return `${OPENCODE_OLLAMA_PROVIDER_ID}/${tag}`
}

export function ollamaTagFromOpenCodeModelId(modelId: string | undefined): string | null {
  if (!modelId) {
    return null
  }
  const prefix = `${OPENCODE_OLLAMA_PROVIDER_ID}/`
  if (!modelId.startsWith(prefix)) {
    return null
  }
  const tag = modelId.slice(prefix.length)
  return isOllamaModelTag(tag) ? tag : null
}

/** Re-inserts `key` last so the cap in `normalizeLaunchContextMemory` evicts the oldest. */
export function rememberLaunchContext(
  memory: LaunchContextMemory | undefined,
  key: string,
  entry: LaunchContextRemembered
): LaunchContextMemory {
  const { [key]: _previous, ...rest } = memory ?? {}
  return { ...rest, [key]: entry }
}

/** A partial change to one target's entry; `null` forgets the target. */
export type LaunchContextPatch = { templateId?: string; ollamaModel?: string } | null

/**
 * Applies one target's change on top of the memory as it is NOW, which is why the main
 * process runs it: a renderer's copy can be stale while other settings writes are in flight.
 */
export function mergeLaunchContextEntry(
  memory: LaunchContextMemory | undefined,
  key: string,
  patch: LaunchContextPatch
): LaunchContextMemory {
  const current = normalizeLaunchContextMemory(memory)
  if (patch === null) {
    const { [key]: _dropped, ...rest } = current
    return rest
  }
  return rememberLaunchContext(current, key, {
    templateId: patch.templateId ?? current[key]?.templateId ?? AGENT_TEMPLATE_DEFAULT_ID,
    ...((patch.ollamaModel ?? current[key]?.ollamaModel)
      ? { ollamaModel: patch.ollamaModel ?? current[key]?.ollamaModel }
      : {})
  })
}

export function normalizeLaunchContextMemory(value: unknown): LaunchContextMemory {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const valid: [string, LaunchContextMemory[string]][] = []
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key || key.length > 300 || !entry || typeof entry !== 'object') {
      continue
    }
    const raw = entry as Record<string, unknown>
    const templateId =
      typeof raw.templateId === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.templateId)
        ? raw.templateId
        : AGENT_TEMPLATE_DEFAULT_ID
    const ollamaModel = isOllamaModelTag(raw.ollamaModel) ? raw.ollamaModel : undefined
    if (
      templateId === AGENT_TEMPLATE_DEFAULT_ID &&
      !ollamaModel &&
      raw.templateId !== AGENT_TEMPLATE_DEFAULT_ID
    ) {
      continue
    }
    valid.push([key, { templateId, ...(ollamaModel ? { ollamaModel } : {}) }])
  }
  // Why: insertion order is age; when over the cap, the oldest entries go, not the newest,
  // and only entries that survived validation count against it.
  return Object.fromEntries(valid.slice(-MAX_MEMORY_ENTRIES))
}

export type LocalOllamaPick = {
  template: AgentTemplate
  /** Ollama tag, or null when nothing is installed. */
  model: string | null
  /** Why this model: helps the row explain itself without a second lookup. */
  modelSource: 'remembered' | 'template' | 'first-installed' | 'none'
  installed: boolean
}

/**
 * Resolution order mirrors what the row shows: what this workspace used last, then the
 * template's preferred model, then the first installed model. A remembered model that is
 * no longer installed is kept (with `installed: false`) so the UI can offer to pull it
 * instead of silently switching.
 */
export function resolveLocalOllamaPick(args: {
  memory: LaunchContextMemory | undefined
  workspaceKey: string
  templates: readonly AgentTemplate[]
  installedTags: readonly string[]
  /** An explicit template choice overrides the remembered one. */
  templateId?: string
}): LocalOllamaPick {
  const remembered = args.memory?.[args.workspaceKey]
  const template = findAgentTemplate(args.templates, args.templateId ?? remembered?.templateId)
  const installedTag = (tag: string): string | undefined =>
    args.installedTags.find((candidate) => sameOllamaTag(candidate, tag))
  const sameTemplate = !args.templateId || args.templateId === remembered?.templateId
  if (remembered?.ollamaModel && sameTemplate) {
    return {
      template,
      model: installedTag(remembered.ollamaModel) ?? remembered.ollamaModel,
      modelSource: 'remembered',
      installed: installedTag(remembered.ollamaModel) !== undefined
    }
  }
  const preferred =
    ollamaTagFromOpenCodeModelId(template.preferredModel) ??
    (isOllamaModelTag(template.preferredModel) ? template.preferredModel : null)
  const preferredInstalled = preferred ? installedTag(preferred) : undefined
  if (preferredInstalled) {
    return { template, model: preferredInstalled, modelSource: 'template', installed: true }
  }
  const rememberedInstalled = remembered?.ollamaModel
    ? installedTag(remembered.ollamaModel)
    : undefined
  if (rememberedInstalled) {
    return { template, model: rememberedInstalled, modelSource: 'remembered', installed: true }
  }
  const first = args.installedTags[0] ?? null
  return {
    template,
    model: first,
    modelSource: first ? 'first-installed' : 'none',
    installed: first !== null
  }
}

/** Stem of the per-launch instructions file a template is written to. */
export function templateInstructionsFileStem(template: AgentTemplate): string {
  return `omni-${template.id}`
}

/**
 * The config OpenCode merges on top of the user's own (`OPENCODE_CONFIG_CONTENT`): the
 * Ollama provider with exactly the launched model, and the template text as an
 * `instructions` file. No agent is declared: an agent `prompt` would REPLACE OpenCode's
 * built-in system prompt, and an unknown agent name gets OpenCode's restrictive default
 * permissions rather than `build`'s. `instructions` are appended after the project and
 * global rules files, which is the layering the templates promise, and the session runs as
 * the ordinary `build` agent.
 */
export function buildOpenCodeLaunchConfig(args: {
  model: string
  template: AgentTemplate
  baseUrl?: string
  contextLength?: number
  /** Absolute paths of the file(s) holding the template text; required for a non-Default template. */
  instructionsPaths?: readonly string[]
}): Record<string, unknown> {
  const baseUrl = args.baseUrl ?? OLLAMA_DEFAULT_BASE_URL
  const modelId = openCodeOllamaModelId(args.model)
  const contextLength =
    typeof args.contextLength === 'number' &&
    Number.isSafeInteger(args.contextLength) &&
    args.contextLength > 0
      ? args.contextLength
      : undefined
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    // Why: compacting cannot shrink fixed tool schemas and can repeatedly auto-continue.
    compaction: { auto: false },
    provider: {
      [OPENCODE_OLLAMA_PROVIDER_ID]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama',
        options: { baseURL: `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1` },
        models: {
          [args.model]: {
            name: args.model,
            // Why: OpenCode validates each layer; a limit needs both context and output.
            ...(contextLength !== undefined
              ? { limit: { context: contextLength, output: 8192 } }
              : {})
          }
        }
      }
    },
    model: modelId
  }
  if (args.template.id !== AGENT_TEMPLATE_DEFAULT_ID && args.template.instructions) {
    if (!args.instructionsPaths?.length) {
      throw new Error('The agent template needs an instructions file to launch with.')
    }
    config.instructions = [...args.instructionsPaths]
  }
  return config
}

export function formatModelSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return ''
  }
  const gb = bytes / 1_073_741_824
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`
}
