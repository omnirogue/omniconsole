import type { CustomModelPreset } from './custom-model-presets'
import type { AgentTemplateSettings } from './agent-templates'
import type { AttentionLaunchFavorite } from './attention-launch-favorites'
import type { LaunchContextMemory } from './local-ollama-launch'
import type { PersistedNativeChatSessionOptions } from './native-chat-session-options'
import type { PrimaryAiPreference } from './omnirogue-account'
import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

export type { PrimaryAiPreference }

export type ConversationLaunchDefaults = Partial<
  Record<TuiAgent, { model?: string; effort?: string; team?: boolean }>
>

function bounded(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim().length <= 200 &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32)
    ? value.trim() || undefined
    : undefined
}

export function normalizeConversationLaunchDefaults(value: unknown): ConversationLaunchDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const result: ConversationLaunchDefaults = {}
  for (const agent of Object.keys(TUI_AGENT_CONFIG) as TuiAgent[]) {
    const entry: unknown = (value as Record<string, unknown>)[agent]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue
    }
    const fields = entry as Record<string, unknown>
    const model = bounded(fields.model)
    const effort = bounded(fields.effort)
    // Why: retain an effort preference for the next explicit model; CLI-default launches omit it.
    const team =
      (agent === 'claude' || agent === 'codex') && typeof fields.team === 'boolean'
        ? fields.team
        : undefined
    if (model || effort || team !== undefined) {
      result[agent] = {
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(team !== undefined ? { team } : {})
      }
    }
  }
  return result
}

export type ConversationLauncherSettings = {
  conversationLaunchDefaults?: ConversationLaunchDefaults
  customModelPresets?: CustomModelPreset[]
  /** Reusable instructions offered by the Local Ollama launcher; see agent-templates.ts. */
  agentTemplates?: AgentTemplateSettings
  /** Last Local Ollama template + model per workspace key. */
  launchContextMemory?: LaunchContextMemory
  /** Opt-in: open new coding-agent tabs in native chat instead of the raw terminal; optional for legacy settings. */
  openAgentTabsInChatByDefault?: boolean
  /** Legacy key for Chat UI; enabled for new profiles while saved false remains an opt-out. */
  experimentalNativeChat?: boolean
  /** Opt-in updated structured runtime; off keeps the existing PTY-backed native chat path. */
  experimentalStructuredNativeChat?: boolean
  agentUseAcp?: Partial<Record<TuiAgent, boolean>>
  /** Saved Attention launch favourites; unset shows the built-in Claude Teams / Codex Team pair. */
  attentionLaunchFavorites?: AttentionLaunchFavorite[]
  /** Last explicit native-chat model + option selections; live panes need an applied/dispatched record before showing a value. */
  nativeChatSessionOptions?: PersistedNativeChatSessionOptions
  /** Preferred primary coding agent, model, and billing mode selected during onboarding or in Settings. */
  primaryAi?: PrimaryAiPreference
}
