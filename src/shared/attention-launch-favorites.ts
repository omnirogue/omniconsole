import {
  listAgentAccountChoices,
  type AgentAccountChoice,
  type AgentAccountSettings
} from './agent-account-profiles'
import {
  checkAgentLaunchPreferences,
  type AgentLaunchPreferenceCheck,
  type AgentLaunchPreferenceSelection
} from './agent-launch-preference-check'
import {
  canRenderNativeChatForAgent,
  nativeChatRequiresLocalTranscript
} from './native-chat-agent-support'
import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

/**
 * Saved launch favourites for the Attention launcher: one actor choice (agent, model,
 * effort, account) plus how the session coordinates workers and which view it opens in.
 * A favourite never carries credentials; the account is a choice id resolved at launch.
 */
export type AttentionLaunchTeam = 'claude-agent-teams' | 'codex-subagents'
export type AttentionLaunchViewMode = 'chat' | 'terminal'

export type AttentionLaunchFavorite = {
  id: string
  label: string
  agent: TuiAgent
  model?: string
  effort?: string
  /** `managed:<id>` / `profile:<id>` from listAgentAccountChoices; null is the current sign-in. */
  accountChoiceId?: string | null
  team?: AttentionLaunchTeam
  viewMode: AttentionLaunchViewMode
}

/** The four providers the launcher always shows, in this order. */
export const ATTENTION_LAUNCH_PROVIDERS = [
  'claude',
  'codex',
  'grok',
  'gemini'
] as const satisfies readonly TuiAgent[]

export const DEFAULT_ATTENTION_LAUNCH_FAVORITES: readonly AttentionLaunchFavorite[] = [
  {
    id: 'claude-teams-opus',
    label: 'Claude Teams · Opus 5.5',
    agent: 'claude-agent-teams',
    // Why: the exact id the local Claude configs select since Opus 5.5 replaced Fable as the default
    // (Sal, 2026-09-24); the bare `opus` alias would drop the 1M-context variant.
    model: 'claude-opus-5-5[1m]',
    team: 'claude-agent-teams',
    viewMode: 'chat'
  },
  {
    id: 'codex-team-astra',
    label: 'Codex Team · Astra',
    agent: 'codex',
    model: 'gpt-6-astra',
    // Why: both local Codex homes now select max; requesting xhigh would silently downgrade the lead.
    effort: 'max',
    team: 'codex-subagents',
    viewMode: 'chat'
  }
]

const MAX_FAVORITES = 12
const FAVORITE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const TEAMS: readonly AttentionLaunchTeam[] = ['claude-agent-teams', 'codex-subagents']

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : undefined
}

function normalizeFavorite(value: unknown): AttentionLaunchFavorite | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  const id = boundedString(record.id, 64)
  const label = boundedString(record.label, 80)
  if (!id || !FAVORITE_ID.test(id) || !label || !isTuiAgent(record.agent)) {
    return null
  }
  const model = boundedString(record.model, 200)
  const effort = model ? boundedString(record.effort, 40) : undefined
  const accountChoiceId = boundedString(record.accountChoiceId, 200)
  const team = TEAMS.includes(record.team as AttentionLaunchTeam)
    ? (record.team as AttentionLaunchTeam)
    : undefined
  return {
    id,
    label,
    agent: record.agent,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(accountChoiceId ? { accountChoiceId } : {}),
    ...(team ? { team } : {}),
    viewMode: record.viewMode === 'chat' ? 'chat' : 'terminal'
  }
}

/** Undefined when nothing valid was saved, so callers fall back to the built-in favourites. */
export function normalizeAttentionLaunchFavorites(
  value: unknown
): AttentionLaunchFavorite[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const seen = new Set<string>()
  const favorites: AttentionLaunchFavorite[] = []
  for (const raw of value) {
    const favorite = normalizeFavorite(raw)
    if (!favorite || seen.has(favorite.id)) {
      continue
    }
    seen.add(favorite.id)
    favorites.push(favorite)
    if (favorites.length >= MAX_FAVORITES) {
      break
    }
  }
  return favorites
}

export function resolveAttentionLaunchFavorites(
  settings: { attentionLaunchFavorites?: AttentionLaunchFavorite[] } | null | undefined
): readonly AttentionLaunchFavorite[] {
  return settings?.attentionLaunchFavorites ?? DEFAULT_ATTENTION_LAUNCH_FAVORITES
}

/** Replace one favourite by id (or append it), keeping the saved order. */
export function upsertAttentionLaunchFavorite(
  favorites: readonly AttentionLaunchFavorite[],
  next: AttentionLaunchFavorite
): AttentionLaunchFavorite[] {
  const index = favorites.findIndex((favorite) => favorite.id === next.id)
  if (index === -1) {
    return [...favorites, next].slice(0, MAX_FAVORITES)
  }
  return favorites.map((favorite, position) => (position === index ? next : favorite))
}

export type AttentionLaunchBlocker =
  | { kind: 'no-workspace' }
  /** Detection finished and the CLI is not on the workspace's execution host. */
  | { kind: 'agent-not-detected' }
  /** Hidden in Settings › Agents; the launcher offers to show it again. */
  | { kind: 'agent-disabled' }
  | { kind: 'invalid-preferences'; message: string }
  /** The saved account choice is no longer offered, so the launch would silently use the default sign-in. */
  | { kind: 'account-missing' }
  /** The saved account is a config directory on this computer; the workspace runs on another host. */
  | { kind: 'account-local-only' }

export type AttentionLaunchView =
  | { mode: 'chat' }
  | {
      mode: 'terminal'
      reason: 'preference' | 'chat-ui-off' | 'agent-unsupported' | 'transcript-not-readable'
    }

export type AttentionLaunchPlan = {
  favorite: AttentionLaunchFavorite
  launchPreferences: AgentLaunchPreferenceSelection | undefined
  /** The saved account the launch starts under; null for the current sign-in or a missing choice. */
  account: AgentAccountChoice | null
  blockers: AttentionLaunchBlocker[]
  view: AttentionLaunchView
  /** Detection is still running; the launch waits until the host has been checked. */
  detectionPending: boolean
}

export function planAttentionLaunch(input: {
  favorite: AttentionLaunchFavorite
  hasWorkspace: boolean
  /** Null while detection for the execution host is still running. */
  detectedAgents: readonly string[] | null
  /** A remote probe ended without a result: availability stays unknown, but nothing is pending. */
  detectionFailed?: boolean
  disabledAgents: readonly string[]
  experimentalNativeChat: boolean
  transcriptLocalReadable: boolean
  /** Settings listing the accounts a favourite's `accountChoiceId` may name. */
  accountSettings: AgentAccountSettings | null | undefined
  /** The workspace runs on an SSH or paired host rather than this computer. */
  targetIsRemote: boolean
}): AttentionLaunchPlan {
  const { favorite } = input
  const blockers: AttentionLaunchBlocker[] = []
  if (!input.hasWorkspace) {
    blockers.push({ kind: 'no-workspace' })
  }
  if (input.disabledAgents.includes(favorite.agent)) {
    blockers.push({ kind: 'agent-disabled' })
  } else if (input.detectedAgents && !input.detectedAgents.includes(favorite.agent)) {
    blockers.push({ kind: 'agent-not-detected' })
  }
  const check: AgentLaunchPreferenceCheck =
    favorite.effort?.trim() && !favorite.model?.trim()
      ? { ok: false, code: 'invalid_argument', message: '--effort requires --model.' }
      : checkAgentLaunchPreferences(favorite.agent, {
          model: favorite.model,
          effort: favorite.effort
        })
  if (!check.ok) {
    blockers.push({ kind: 'invalid-preferences', message: check.message })
  }
  const account = resolveFavoriteAccount(input.accountSettings, favorite)
  if (favorite.accountChoiceId && !account) {
    blockers.push({ kind: 'account-missing' })
  } else if (account && input.targetIsRemote) {
    // Why: every saved account is a config directory on this computer; exporting that path
    // on an SSH or paired host would point the CLI at a directory that host doesn't have.
    blockers.push({ kind: 'account-local-only' })
  }
  return {
    favorite,
    launchPreferences: check.ok ? check.preferences : undefined,
    account,
    blockers,
    view: resolveAttentionLaunchView(input),
    detectionPending: input.detectedAgents === null && input.detectionFailed !== true
  }
}

function resolveFavoriteAccount(
  settings: AgentAccountSettings | null | undefined,
  favorite: AttentionLaunchFavorite
): AgentAccountChoice | null {
  const choiceId = favorite.accountChoiceId
  if (!choiceId) {
    return null
  }
  const choices = listAgentAccountChoices(settings, favorite.agent)
  return choices.find((choice) => choice.id === choiceId) ?? null
}

/**
 * How the launcher hands its prompt to the new session. A launcher prompt is always meant to
 * be sent: argv and flag agents submit it from the command line, while agents that only take
 * input after start would get it pasted as an unsent draft, so they paste and submit once ready.
 */
export function attentionLaunchPromptDelivery(
  agent: TuiAgent,
  prompt: string
): 'auto-submit' | 'submit-after-ready' {
  return prompt.trim().length > 0 &&
    TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
    ? 'submit-after-ready'
    : 'auto-submit'
}

function resolveAttentionLaunchView(input: {
  favorite: AttentionLaunchFavorite
  experimentalNativeChat: boolean
  transcriptLocalReadable: boolean
}): AttentionLaunchView {
  const { agent, viewMode } = input.favorite
  if (viewMode === 'terminal') {
    return { mode: 'terminal', reason: 'preference' }
  }
  if (!canRenderNativeChatForAgent(agent)) {
    return { mode: 'terminal', reason: 'agent-unsupported' }
  }
  if (!input.experimentalNativeChat) {
    return { mode: 'terminal', reason: 'chat-ui-off' }
  }
  if (nativeChatRequiresLocalTranscript(agent) && !input.transcriptLocalReadable) {
    return { mode: 'terminal', reason: 'transcript-not-readable' }
  }
  return { mode: 'chat' }
}

function describeActorModel(favorite: AttentionLaunchFavorite): string | null {
  if (!favorite.model) {
    return null
  }
  return favorite.effort ? `${favorite.model} at ${favorite.effort} effort` : favorite.model
}

/**
 * The first message a team favourite sends. Coordination is the provider's own feature
 * (Claude Agent Teams, Codex subagents); this only states how to use it and which model
 * the workers keep, so a simple request never fans out into a team.
 */
export function buildAttentionLaunchPrompt(
  favorite: AttentionLaunchFavorite,
  request: string
): string {
  const trimmed = request.trim()
  if (!favorite.team) {
    return trimmed
  }
  const tail = trimmed
    ? `\n\nRequest:\n${trimmed}`
    : '\n\nAsk me what I need before starting any work.'
  return `${attentionLaunchTeamInstructions(favorite)}${tail}`
}

export function attentionLaunchTeamInstructions(favorite: AttentionLaunchFavorite): string {
  const workers = favorite.team === 'claude-agent-teams' ? 'teammates' : 'Codex subagents'
  const actorModel = describeActorModel(favorite)
  const lines = [
    `You lead this work. Use ${workers} only for parts that can run independently and in parallel; do simple requests yourself without starting workers.`,
    actorModel
      ? `Start every worker on ${actorModel}, the same as you, unless I name an exception.`
      : 'Start every worker on the same model as you unless I name an exception.',
    'Before starting workers, list each one and what it will do; then report their progress and results as they finish.'
  ]
  return lines.join('\n')
}
