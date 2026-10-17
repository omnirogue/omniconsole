import type { TuiAgent } from '../../shared/tui-agent'
import type { PersistedNativeChatSessionOptions } from '../../shared/native-chat-session-options'
import { resolveStructuredLaunchSeedOptions } from '../../shared/native-chat-session-option-defaults'
import { parseCodexModelCatalog } from '../../shared/commit-message-model-parsers'
import type { CommitMessageModel } from '../../shared/commit-message-agent-spec'
import { hasExplicitAgentSessionDefaultSelection } from '../../shared/agent-session-default-selection'
import { resolveStartupShell } from '../../shared/tui-agent-startup-shell'
import {
  createTomlLineScanState,
  isTomlStructuralLine,
  updateTomlLineScanState
} from '../codex/config-toml-line-scan'
import { parseTomlKeyPath } from '../codex/config-toml-key-path'
import { joinWorktreeRelativePath as join } from './runtime-relative-paths'

const CODEX_PRIMARY_MODEL = 'gpt-6.1-sol'
// Reuse Codex's cache policy; this reads its existing cache and never creates one.
// https://github.com/openai/codex/blob/main/codex-rs/models-manager/src/manager.rs
const CODEX_MODEL_CACHE_TTL_MS = 300_000

function hasCodexSelection(content: string): boolean {
  let state = createTomlLineScanState()
  for (const line of content.split('\n')) {
    if (isTomlStructuralLine(state)) {
      const key = parseTomlKeyPath(line)
      if (
        key &&
        line[key.end] === '=' &&
        key.segments.some((part) =>
          ['model', 'model_reasoning_effort', 'model_provider', 'profile'].includes(part)
        )
      ) {
        return true
      }
    }
    state = updateTomlLineScanState(state, line)
  }
  return false
}

function hasClaudeSelection(content: string): boolean {
  const value: unknown = JSON.parse(content)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The execution host could not verify Claude settings.')
  }
  const settings = value as Record<string, unknown>
  return ['model', 'effortLevel', 'modelSettings'].some((key) => settings[key] !== undefined)
}

/** Only an untouched create opts into product defaults; provider resumes never call this. */
export async function resolveNewAgentSessionDefaults(input: {
  agent: TuiAgent
  options?: Readonly<Record<string, string>>
  persisted?: PersistedNativeChatSessionOptions
  agentArgs?: string | null
  commandOverride?: string
  env?: Readonly<Record<string, string | undefined>>
  accountHome?: string
  resolveAccountHome?: () => Promise<string | undefined>
  workspacePath: string
  readFile: (path: string) => Promise<string | null>
  now?: number
  discoverModels?: (accountHome: string) => Promise<readonly CommitMessageModel[] | null>
}): Promise<Readonly<Record<string, string>> | undefined> {
  if (!['claude', 'codex'].includes(input.agent) || input.options?.model) {
    return input.options
  }
  const effortOnly = Boolean(input.options?.effort)
  if (
    hasExplicitAgentSessionDefaultSelection({
      ...input,
      shell: resolveStartupShell(process.platform),
      effortOnly
    })
  ) {
    return effortOnly ? undefined : input.options
  }
  if (effortOnly) {
    return input.options
  }
  const saved = resolveStructuredLaunchSeedOptions(input.persisted, input.agent)
  if (saved) {
    return { ...saved, ...input.options }
  }
  const accountHome = input.resolveAccountHome
    ? await input.resolveAccountHome()
    : input.accountHome
  if (!accountHome) {
    throw new Error(
      'The execution host could not verify the account’s new-session defaults. Select a model and effort explicitly.'
    )
  }
  const configName = input.agent === 'codex' ? 'config.toml' : 'settings.json'
  const configPaths = [
    join(accountHome, configName),
    join(input.workspacePath, `${input.agent === 'codex' ? '.codex' : '.claude'}/${configName}`),
    ...(input.agent === 'claude' ? [join(input.workspacePath, '.claude/settings.local.json')] : [])
  ]
  for (const path of configPaths) {
    const content = await input.readFile(path)
    if (
      content !== null &&
      (input.agent === 'codex' ? hasCodexSelection(content) : hasClaudeSelection(content))
    ) {
      return input.options
    }
  }
  if (input.agent === 'codex') {
    const cache = await input.readFile(join(accountHome, 'models_cache.json'))
    const catalog = cache === null ? null : parseCodexModelCatalog(cache)
    const models = catalog?.models ?? []
    const fetchedAt = catalog?.fetchedAt ? Date.parse(catalog.fetchedAt) : Number.NaN
    const age = (input.now ?? Date.now()) - fetchedAt
    const cachedModel =
      Number.isFinite(age) && age >= 0 && age <= CODEX_MODEL_CACHE_TTL_MS
        ? models.find((row) => row.id === CODEX_PRIMARY_MODEL)
        : undefined
    const model =
      cachedModel ??
      (await input.discoverModels?.(accountHome))?.find((row) => row.id === CODEX_PRIMARY_MODEL)
    if (!model?.thinkingLevels?.some((level) => level.id === 'medium')) {
      throw new Error(
        'The execution host could not verify GPT-6.1 Sol / medium in this account’s model catalog. Select a model explicitly. Catalog eligibility does not establish remaining model capacity.'
      )
    }
  }
  return {
    ...input.options,
    model: input.agent === 'codex' ? CODEX_PRIMARY_MODEL : 'opus',
    effort: 'medium'
  }
}
