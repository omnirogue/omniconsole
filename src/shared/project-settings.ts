import { z } from 'zod'
import { accountSyncValueSize, ACCOUNT_SYNC_VALUE_MAX_BYTES } from './account-sync-types'
import { agentTemplateDigest, type AgentTemplate } from './agent-templates'
import { consoleJiraWorkRef } from './console-jira-work-contract'
import {
  SESSION_CONTEXT_MAX_ITEMS,
  sessionContextAttachmentSchema,
  validateSessionContext,
  type SessionContextAttachment
} from './session-context-attachments'
import type { TuiAgent } from './tui-agent'

/**
 * A project's settings: what every session started inside the project folder inherits (Sessions
 * plan §8). One record per project folder (Group-by project's rule, session-project-folder.ts),
 * kept with the session folders and synced with them. People make projects; agents may only
 * suggest one (Sal, 2026-09-01), so `createdBy` is always `person`.
 */

export const PROJECT_MAX_REPOS = 20
export const PROJECT_MAX_AGENTS = 10
export const PROJECT_MAX_HOSTS = 20
export const PROJECT_MAX_TASKS = 20
export const PROJECT_AGENT_INSTRUCTIONS_MAX = 12_000

const LABEL = z.string().trim().min(1).max(80)

/** #895's identity: the remote's canonical key; a `path:` identity names one checkout, so it is refused. */
export const projectRepoSchema = z.object({
  gitIdentity: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine((identity) => !identity.startsWith('path:'), {
      message: 'A repo without a remote cannot be found on other computers. Add a remote first.'
    })
})

/** #891's identity plus the text, so the agent reaches a computer that lacks the template. */
export const projectAgentSchema = z.object({
  templateId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  digest: z.string().regex(/^[0-9a-f]{12}$/),
  instructions: z.string().max(PROJECT_AGENT_INSTRUCTIONS_MAX)
})

export const projectHostPolicySchema = z.union([
  z.literal('as-named'),
  z.literal('auto'),
  z.array(z.string().trim().min(1).max(512)).min(1).max(PROJECT_MAX_HOSTS)
])

/**
 * The project's chat (backend plan §1): how its coordinator launches, as the folder launcher's
 * own pick, and the session running it once started. `agent` stays open text so a record naming
 * an agent this build lacks is kept, not dropped with the whole project.
 */
export const projectCoordinatorSchema = z.object({
  launch: z.object({
    agent: z.custom<TuiAgent>(
      (value) => typeof value === 'string' && value.length > 0 && value.length <= 64
    ),
    /** Local Ollama is agent `opencode` with model `ollama/<tag>`. */
    model: z.string().min(1).max(200).optional(),
    effort: z.string().min(1).max(32).optional(),
    /** Claude or Codex only: Claude Agent Teams, or Codex with subagents. */
    team: z.boolean().optional(),
    templateId: z.string().min(1).max(64).optional()
  }),
  /** The running coordinator's provider or provisional session key. */
  sessionKey: z.string().min(1).max(1000).optional()
})

export const projectSettingsSchema = z.object({
  repos: z.array(projectRepoSchema).max(PROJECT_MAX_REPOS),
  attachments: z.array(sessionContextAttachmentSchema),
  agents: z.array(projectAgentSchema).max(PROJECT_MAX_AGENTS),
  /** A list orders where work runs; worker-start reads it (project-host-policy.ts). */
  hostPolicy: projectHostPolicySchema,
  company: LABEL.optional(),
  domain: LABEL.optional(),
  coordinator: projectCoordinatorSchema.optional(),
  /** Jira issues the project works on (plan §5): links for its page and coordinator, never a brief. */
  tasks: z.array(consoleJiraWorkRef).max(PROJECT_MAX_TASKS).optional(),
  createdBy: z.literal('person'),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative()
})

export type ProjectRepo = z.infer<typeof projectRepoSchema>
export type ProjectAgent = z.infer<typeof projectAgentSchema>
export type ProjectHostPolicy = z.infer<typeof projectHostPolicySchema>
export type ProjectCoordinator = z.infer<typeof projectCoordinatorSchema>
export type ProjectSettings = z.infer<typeof projectSettingsSchema>

export function emptyProjectSettings(now: number): ProjectSettings {
  return {
    repos: [],
    attachments: [],
    agents: [],
    hostPolicy: 'as-named',
    createdBy: 'person',
    createdAt: now,
    updatedAt: now
  }
}

export function projectAgentFor(template: AgentTemplate): ProjectAgent | null {
  const instructions = template.instructions?.trim()
  if (!instructions) {
    return null
  }
  return {
    templateId: template.id,
    name: template.name,
    digest: agentTemplateDigest(template.instructions),
    instructions: instructions.slice(0, PROJECT_AGENT_INSTRUCTIONS_MAX)
  }
}

/** A skill is stored by name, so each computer can find its own copy; other kinds as they are. */
export function projectAttachmentForm(item: SessionContextAttachment): SessionContextAttachment {
  if (item.kind !== 'skill') {
    return item
  }
  return { id: `skill-name:${item.title}`, kind: 'skill', title: item.title }
}

const ORCHESTRATION_SKILL = 'orchestration'

/** Binds the project's chat; the `orchestration` skill is listed by name so its host has it. */
export function withProjectCoordinator(
  settings: ProjectSettings,
  coordinator: ProjectCoordinator
): ProjectSettings {
  const listed = settings.attachments.some(
    (item) => item.kind === 'skill' && item.title === ORCHESTRATION_SKILL
  )
  // Why the room check: a full list still takes the coordinator; the skill is only a convenience.
  if (listed || settings.attachments.length >= SESSION_CONTEXT_MAX_ITEMS) {
    return { ...settings, coordinator }
  }
  const skill = projectAttachmentForm({
    id: ORCHESTRATION_SKILL,
    kind: 'skill',
    title: ORCHESTRATION_SKILL
  })
  return { ...settings, coordinator, attachments: [...settings.attachments, skill] }
}

/** True for a reference that names one computer's file: it cannot travel to another host. */
export function isHostBoundAttachment(item: SessionContextAttachment): boolean {
  return (
    ((item.kind === 'file' || item.kind === 'folder') && !item.repo) ||
    (item.kind === 'skill' && !!item.uri)
  )
}

/** The same budget and rules a session's own context has, plus one synced document's size. */
export function projectSettingsError(settings: ProjectSettings): string | null {
  const parsed = projectSettingsSchema.safeParse(settings)
  if (!parsed.success) {
    return parsed.error.issues[0]?.message ?? 'These project settings are not valid.'
  }
  try {
    validateSessionContext(settings.attachments)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  const identities = new Set(settings.repos.map((repo) => repo.gitIdentity.toLowerCase()))
  if (identities.size !== settings.repos.length) {
    return 'That repo is already in this project.'
  }
  const issues = new Set(settings.tasks?.map((ref) => `${ref.cloud_id}:${ref.issue_id}`))
  if (issues.size !== (settings.tasks?.length ?? 0)) {
    return 'That issue is already on this project.'
  }
  if (
    accountSyncValueSize({ v: 1, p: { x: { v: settings, t: 0 } } }) > ACCOUNT_SYNC_VALUE_MAX_BYTES
  ) {
    return 'These project settings are too large to follow your account to other computers. Remove an attachment or shorten an agent’s instructions.'
  }
  return null
}

/** A record another computer or an older store wrote: anything malformed is dropped, never trusted. */
export function parseProjectSettings(value: unknown): ProjectSettings | null {
  const parsed = projectSettingsSchema.safeParse(value)
  return parsed.success && projectSettingsError(parsed.data) === null ? parsed.data : null
}

/** Field order as the schema writes it, so two equal records compare equal however built. */
export function sameProjectSettings(left: ProjectSettings, right: ProjectSettings): boolean {
  const canonical = (settings: ProjectSettings) =>
    JSON.stringify(projectSettingsSchema.safeParse(settings).data ?? settings)
  return canonical(left) === canonical(right)
}
