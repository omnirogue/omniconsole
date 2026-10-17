import { normalizeAutomaticSessionCleanupProtection } from '../../../../shared/automatic-session-cleanup-protection'
import {
  MIN_IDLE_AUTO_CLOSE_MINUTES,
  MAX_IDLE_AUTO_CLOSE_MINUTES
} from '../../../../shared/idle-auto-close-settings'
import { z } from 'zod'
import { normalizePRBotAuthorOverrides } from '../../../../shared/pr-bot-author-overrides'
import { isTaskProvider } from '../../../../shared/task-providers'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../../../../shared/tui-agent-launch-defaults'
import { normalizeAgentAccountProfiles } from '../../../../shared/agent-account-profiles'
import {
  normalizeSessionActionPresetSettings,
  normalizeSessionActionPresetsByWorkspace
} from '../../../../shared/session-action-presets'
import { normalizeAgentTemplateSettings } from '../../../../shared/agent-templates'
import { normalizeLaunchContextMemory } from '../../../../shared/local-ollama-launch'
import { normalizeDisabledTuiAgents } from '../../../../shared/tui-agent-selection'
import { normalizeAttentionLaunchFavorites } from '../../../../shared/attention-launch-favorites'
import { WorktreeVisibilityDefaultsUpdate } from './worktree-visibility-defaults-schema'
import type { TaskProvider } from '../../../../shared/task-providers'

const TaskProviderParam = z.custom<TaskProvider>(isTaskProvider, {
  message: 'Unknown task provider'
})

export const PRBotAuthorOverrideUpdate = z
  .object({ author: z.string(), isBot: z.boolean() })
  .strict()

const NativeChatSessionOptionPickBase = {
  modelId: z.string().trim().min(1).max(512),
  adoptModelAsLaunchDefault: z.boolean().optional()
}

const NativeChatSessionOptionPick = z.union([
  z
    .object({
      ...NativeChatSessionOptionPickBase,
      optionId: z.enum(['model', 'effort']),
      value: z.string().trim().min(1).max(512)
    })
    .strict(),
  z
    .object({
      ...NativeChatSessionOptionPickBase,
      optionId: z.enum(['fastMode', 'thinking']),
      value: z.boolean()
    })
    .strict()
])

export const NativeChatSessionOptionsMutation = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('apply-picks'),
      agent: z.enum(['claude', 'codex', 'gemini', 'cursor', 'grok']),
      picks: z.array(NativeChatSessionOptionPick).min(1).max(8)
    })
    .strict(),
  z
    .object({
      type: z.literal('clear-model-if-missing'),
      agent: z.enum(['claude', 'codex', 'gemini', 'cursor', 'grok']),
      availableModelIds: z.array(z.string().trim().min(1).max(512)).min(1).max(256)
    })
    .strict()
])

const GitHubProjectRef = z
  .object({
    owner: z.string(),
    ownerType: z.enum(['organization', 'user']),
    number: z.number().int(),
    host: z.string().optional()
  })
  .strict()
const GitHubProjectSettings = z
  .object({
    pinned: z.array(GitHubProjectRef),
    recent: z.array(
      GitHubProjectRef.extend({
        lastOpenedAt: z.string()
      }).strict()
    ),
    lastViewByProject: z.record(z.string(), z.object({ viewId: z.string() }).strict()),
    activeProject: GitHubProjectRef.nullable()
  })
  .strict()

const AutomaticSessionCleanupProtection = z
  .object({
    protectedWorkspacePaths: z.array(z.string().min(1)),
    protectedPaneKeys: z.array(z.string().min(1)),
    protectStartedToday: z.boolean(),
    timeZone: z.string().min(1)
  })
  .strict()
  .refine((value) => normalizeAutomaticSessionCleanupProtection(value) !== null, {
    message: 'Invalid owner-local cleanup protection'
  })
  .transform((value) => normalizeAutomaticSessionCleanupProtection(value)!)

export const SettingsUpdate = z
  .object({
    worktreeVisibilityDefaults: WorktreeVisibilityDefaultsUpdate.optional(),
    idleAutoCloseMode: z.enum(['shadow', 'on', 'off']).optional(),
    idleAutoCloseMinutes: z
      .number()
      .finite()
      .min(MIN_IDLE_AUTO_CLOSE_MINUTES)
      .max(MAX_IDLE_AUTO_CLOSE_MINUTES)
      .optional(),
    automaticSessionCleanupProtection: AutomaticSessionCleanupProtection.nullable().optional(),
    defaultTuiAgent: z
      .unknown()
      .transform((value) =>
        value === null || value === 'blank' || isTuiAgent(value) ? value : undefined
      )
      .optional(),
    disabledTuiAgents: z
      .unknown()
      .transform((value) => normalizeDisabledTuiAgents(value))
      .optional(),
    agentDefaultArgs: z
      .unknown()
      .transform((value) => normalizeTuiAgentArgsRecord(value))
      .optional(),
    agentDefaultEnv: z
      .unknown()
      .transform((value) => normalizeTuiAgentEnvRecord(value))
      .optional(),
    agentAccountProfiles: z
      .unknown()
      .transform((value) => normalizeAgentAccountProfiles(value))
      .optional(),
    attentionLaunchFavorites: z
      .unknown()
      .transform((value) => normalizeAttentionLaunchFavorites(value))
      .optional(),
    agentTemplates: z
      .unknown()
      .transform((value) => normalizeAgentTemplateSettings(value))
      .optional(),
    launchContextMemory: z
      .unknown()
      .transform((value) => normalizeLaunchContextMemory(value))
      .optional(),
    sessionActionPresets: z
      .unknown()
      .transform((value) => normalizeSessionActionPresetSettings(value))
      .optional(),
    sessionActionPresetsByWorkspace: z
      .unknown()
      .transform((value) => normalizeSessionActionPresetsByWorkspace(value))
      .optional(),
    defaultTaskSource: TaskProviderParam.optional(),
    visibleTaskProviders: z.array(TaskProviderParam).optional(),
    defaultTaskViewPreset: z
      .enum(['issues', 'my-issues', 'prs', 'my-prs', 'review', 'all'])
      .optional(),
    experimentalNewWorktreeCardStyle: z.boolean().optional(),
    agentStatusHooksEnabled: z.boolean().optional(),
    defaultRepoSelection: z.array(z.string()).nullable().optional(),
    defaultLinearTeamSelection: z.array(z.string()).nullable().optional(),
    compactWorktreeCards: z.boolean().optional(),
    minimaxGroupId: z.string().optional(),
    minimaxUsageModels: z.string().optional(),
    githubProjects: GitHubProjectSettings.optional(),
    prBotAuthorOverrides: z
      .unknown()
      .transform((value) => normalizePRBotAuthorOverrides(value))
      .optional()
  })
  .strict()
  .default({})
