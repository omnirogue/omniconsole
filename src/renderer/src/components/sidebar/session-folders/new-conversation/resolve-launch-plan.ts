import type { SessionAgentTemplate } from '../../../../../../shared/session-agent-template'
import type { SessionContextAttachment } from '../../../../../../shared/session-context-attachments'
import type { LaunchManifest } from '../../../../../../shared/launch-manifest'
import type { LaunchSessionContextClaim } from '@/lib/launch-session-context'
import type { AgentLaunchPreferences } from '../../../../../../shared/agent-session-host-authority'
import {
  attentionLaunchTeamInstructions,
  buildAttentionLaunchPrompt
} from '../../../../../../shared/attention-launch-favorites'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type {
  AccountCapacityRow,
  CapacityProvider
} from '../../../../../../shared/provider-account-capacity'
import type { ConversationLaunchDefaults } from '../../../../../../shared/conversation-launch-defaults'
import type { AgentLaunchPreferenceSelection } from '../../../../../../shared/agent-launch-preference-check'
import { checkAgentLaunchPreferences } from '../../../../../../shared/agent-launch-preference-check'
import type { CatalogModel } from '../../../../../../shared/agent-session-option-catalog'
import { effortChoicesFor } from '../../../../../../shared/build-review-model-options'
import { sortCapacityRows } from '@/lib/account-capacity-format'
import { translate } from '@/i18n/i18n'
import { openrouterApiId } from '../../../../../../shared/openrouter-route'

import { DEFAULT_OMP_OPENROUTER_MODEL } from '../../../../../../shared/omp-launch-model'

export const LAUNCHER_PROVIDERS = [
  'claude',
  'codex',
  'kimi',
  'grok',
  'muse',
  'omp',
  'gemini'
] as const
export type LauncherProvider = (typeof LAUNCHER_PROVIDERS)[number]

/** An installed agent CLI the launcher lists under "Other agents" rather than as a provider row. */
export function isOtherLauncherAgent(id: TuiAgent): boolean {
  return id !== 'claude-agent-teams' && !LAUNCHER_PROVIDERS.some((provider) => provider === id)
}
export type LaunchPick = {
  sessionContext?: readonly SessionContextAttachment[]
  /** Project items the person left out of this session (project-launch.ts). */
  sessionContextRemoved?: readonly string[]
  /** The launcher's one-shot context this launch read; cleared once it has started. */
  launchContextClaim?: LaunchSessionContextClaim
  agent?: LauncherProvider
  /** An "Other agents" CLI; it launches as is, with no account, model or team choice. */
  otherAgent?: TuiAgent
  account?: AccountCapacityRow & { runtimeEnvironmentId?: string }
  model?: string
  effort?: string
  team?: boolean
  customModelId?: string
  /** Agent template whose instructions open the session; see launch-context.ts. */
  templateId?: string
  /** What the session records about that template; absent for Default. */
  agentTemplate?: SessionAgentTemplate
  /** Everything the launch attaches, as reviewed; Session details keeps it (launch-manifest.ts). */
  launchManifest?: LaunchManifest
  teamInstructions?: string
  /** The template delivered as the opening message (`note` for the company path). */
  opening?: { prompt: string; promptDelivery: 'submit-after-ready'; note: string }
}
export type LauncherCapability = {
  id: TuiAgent
  status: string
  models: CatalogModel[]
  label: string
}

export function accountCanLaunch(row: AccountCapacityRow): boolean {
  return row.state !== 'signed-out' && Boolean(row.launchEnv && Object.keys(row.launchEnv).length)
}

export function resolveLaunchPreferences(
  agent: TuiAgent,
  models: CatalogModel[],
  saved: AgentLaunchPreferenceSelection = {},
  pick: LaunchPick = {}
): AgentLaunchPreferences | undefined {
  const selectedModel = Object.hasOwn(pick, 'model') ? pick.model : saved.model
  // Why: Gemini must receive an explicit model instead of inheriting the CLI default.
  const model =
    agent === 'gemini' && !models.some((candidate) => candidate.id === selectedModel)
      ? models.find((candidate) => candidate.isDefault)?.id
      : selectedModel
  if (!model || !models.some((candidate) => candidate.id === model)) {
    return undefined
  }
  const effort = Object.hasOwn(pick, 'effort') ? pick.effort : saved.effort
  const validEffort = effortChoicesFor(agent, models, model).some(
    (choice) => choice.value === effort
  )
    ? effort
    : undefined
  const checked = checkAgentLaunchPreferences(agent, { model, effort: validEffort })
  if (checked.ok) {
    return checked.preferences
  }
  const modelOnly = checkAgentLaunchPreferences(agent, { model })
  return modelOnly.ok ? modelOnly.preferences : undefined
}

type Plan =
  | { kind: 'model-unavailable'; message: string }
  | { kind: 'target-required' }
  | { kind: 'provider-unavailable' }
  | { kind: 'sign-in-required' }
  | {
      kind: 'launch'
      agent: TuiAgent
      teamPrompt?: string
      teamInstructions?: string
      launchEnv?: Record<string, string>
      launchPreferences?: AgentLaunchPreferences
      fallbackAccount?: AccountCapacityRow
      limitedAccount?: AccountCapacityRow
    }

function resolveProviderLaunchPlan(input: {
  hasTarget: boolean
  local: boolean
  accountEnvironmentId?: string | null
  defaultProvider?: TuiAgent | 'blank' | null
  capabilities: LauncherCapability[]
  rows: Record<CapacityProvider, (AccountCapacityRow & { runtimeEnvironmentId?: string })[]>
  defaults?: ConversationLaunchDefaults
  pick?: LaunchPick
}): Plan {
  if (!input.hasTarget) {
    return { kind: 'target-required' }
  }
  const pick = input.pick ?? {}
  if (pick.customModelId !== undefined) {
    const model = `openrouter/${pick.customModelId}`
    const entry = input.capabilities.find((candidate) => candidate.id === 'omp')
    if (
      !openrouterApiId.safeParse(pick.customModelId).success ||
      entry?.status !== 'usable' ||
      !entry.models.some(
        (candidate) =>
          candidate.id === model && candidate.openrouterRouting === 'omp-openrouter-routing-v1'
      )
    ) {
      return {
        kind: 'model-unavailable',
        message: translate(
          'customModels.unavailable',
          '{{model}} is unavailable or could not be verified on this host. Check OMP installation and OpenRouter authentication, then refresh. No other model was started.',
          { model: pick.customModelId }
        )
      }
    }
    return { kind: 'launch', agent: 'omp', launchPreferences: { model } }
  }
  if (pick.otherAgent !== undefined) {
    const usable = input.capabilities.some(
      (entry) => entry.id === pick.otherAgent && entry.status === 'usable'
    )
    return usable && isOtherLauncherAgent(pick.otherAgent)
      ? { kind: 'launch', agent: pick.otherAgent }
      : { kind: 'provider-unavailable' }
  }
  const available = LAUNCHER_PROVIDERS.filter((id) =>
    input.capabilities.some((entry) => entry.id === id && entry.status === 'usable')
  )
  const agent = pick.agent ?? available.find((id) => id === input.defaultProvider) ?? available[0]
  if (!agent || !available.includes(agent)) {
    return { kind: 'provider-unavailable' }
  }
  if (agent === 'omp') {
    const selected =
      pick.model ?? input.defaults?.omp?.model ?? `openrouter/${DEFAULT_OMP_OPENROUTER_MODEL}`
    return resolveLaunchPlan({
      ...input,
      pick: { ...pick, customModelId: selected.replace(/^openrouter\//, '') }
    })
  }
  const models = input.capabilities.find((entry) => entry.id === agent)?.models ?? []
  const launchPreferences = resolveLaunchPreferences(agent, models, input.defaults?.[agent], pick)
  if (agent === 'gemini' && !launchPreferences) {
    return { kind: 'provider-unavailable' }
  }
  if ((!input.local && !input.accountEnvironmentId) || (agent !== 'claude' && agent !== 'codex')) {
    return { kind: 'launch', agent, launchPreferences }
  }
  if (
    pick.account &&
    (pick.account.runtimeEnvironmentId ?? null) !== (input.accountEnvironmentId ?? null)
  ) {
    return { kind: 'sign-in-required' }
  }
  const rows = sortCapacityRows(
    input.rows[agent].filter(
      (row) => (row.runtimeEnvironmentId ?? null) === (input.accountEnvironmentId ?? null)
    )
  )
  if (rows.length === 0 && !pick.account) {
    return { kind: 'launch', agent, launchPreferences }
  }
  const preferred = pick.account
    ? rows.find((row) => row.choiceId === pick.account?.choiceId)
    : rows.find((row) => row.isDefault)
  // First-read placeholders are not evidence of a missing login. This applies
  // both to the auto-selected default row and to an explicit pick of that same
  // default row (a checking row can only be explicitly picked while it is the
  // default — non-default checking rows stay disabled in the UI, and if picked
  // anyway they fall through to sign-in-required below).
  if (preferred?.state === 'checking' && preferred.isDefault && !accountCanLaunch(preferred)) {
    return { kind: 'launch', agent, launchPreferences }
  }
  const row =
    preferred && accountCanLaunch(preferred)
      ? preferred
      : pick.account
        ? undefined
        : preferred && preferred.state !== 'signed-out'
          ? undefined
          : rows.find(
              (candidate) =>
                (candidate.state === 'ready' || candidate.state === 'usable') &&
                accountCanLaunch(candidate)
            )
  if (!row) {
    return { kind: 'sign-in-required' }
  }
  return {
    kind: 'launch',
    agent,
    launchPreferences,
    launchEnv: row.launchEnv ?? undefined,
    ...(rows.find((candidate) => candidate.isDefault)?.choiceId !== row.choiceId
      ? { fallbackAccount: row }
      : {}),
    ...(row.state === 'limited' ? { limitedAccount: row } : {})
  }
}

export function resolveLaunchPlan(input: Parameters<typeof resolveProviderLaunchPlan>[0]): Plan {
  const plan = resolveProviderLaunchPlan(input)
  if (plan.kind !== 'launch' || (plan.agent !== 'claude' && plan.agent !== 'codex')) {
    return plan
  }
  const team = input.pick?.team ?? input.defaults?.[plan.agent]?.team ?? false
  if (!team) {
    return plan
  }
  const agent: TuiAgent = plan.agent === 'claude' ? 'claude-agent-teams' : 'codex'
  if (
    agent === 'claude-agent-teams' &&
    !input.capabilities.some((entry) => entry.id === agent && entry.status === 'usable')
  ) {
    return {
      kind: 'model-unavailable',
      message: translate(
        'conversationLauncher.teamsUnavailable',
        'Claude Agent Teams is unavailable on this host. Enable it in Settings → Agents or choose Single agent.'
      )
    }
  }
  const favorite = {
    id: 'conversation-team',
    label: translate('conversationLauncher.teamLabel', 'Team'),
    agent,
    ...plan.launchPreferences,
    team:
      agent === 'claude-agent-teams'
        ? ('claude-agent-teams' as const)
        : ('codex-subagents' as const),
    viewMode: 'chat' as const
  }
  return {
    ...plan,
    agent,
    teamInstructions: attentionLaunchTeamInstructions(favorite),
    teamPrompt: input.pick?.launchManifest
      ? undefined
      : buildAttentionLaunchPrompt(favorite, input.pick?.opening?.prompt ?? '')
  }
}

export function teamLaunchOpening(prompt: string | undefined) {
  return prompt ? { prompt, note: prompt, promptDelivery: 'submit-after-ready' as const } : {}
}
