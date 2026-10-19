import { translate } from '@/i18n/i18n'
import {
  AGENT_TEMPLATE_DEFAULT_ID,
  agentTemplateDigest,
  type AgentTemplate
} from '../../../../shared/agent-templates'
import {
  emptyProjectSettings,
  projectAgentFor,
  type ProjectAgent,
  type ProjectCoordinator,
  type ProjectRepo,
  type ProjectSettings,
  type ProjectThreadLaunch,
  type ProjectThreadMemory
} from '../../../../shared/project-settings'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SessionContextAttachment } from '../../../../shared/session-context-attachments'
import { getRepoGitIdentity } from '../../../../shared/folder-workspace-attached-repos'
import type { Repo } from '../../../../shared/repo-types'

export type ProjectHostMode = 'as-named' | 'auto' | 'hosts'

/** The built-in template the project's chat opens with (backend plan §1). */
export const COORDINATOR_TEMPLATE_ID = 'coordinator'

/** Agents the dialog offers for the project's chat: the folder launcher's providers. */
export const COORDINATOR_AGENTS: readonly TuiAgent[] = [
  'claude',
  'codex',
  'kimi',
  'deepseek',
  'grok',
  'gemini',
  'omp'
]

/** The chat's Local Ollama pick: OpenCode as the runner, an `ollama/<tag>` model. */
export const LOCAL_OLLAMA_AGENT: TuiAgent = 'opencode'

/** Only Claude (Agent Teams) and Codex (subagents) run as a team. */
export function coordinatorAgentOffersTeam(agent: TuiAgent): boolean {
  return agent === 'claude' || agent === 'codex'
}

function coordinatorAgentOffered(agent: string): agent is TuiAgent {
  return (COORDINATOR_AGENTS as readonly string[]).includes(agent)
}

/** The chat's pick as the dialog edits it; model and effort belong to the agent and clear with it. */
export type ProjectCoordinatorDraft = {
  agent: TuiAgent
  team: boolean
  model?: string
  effort?: string
}

/** What the dialog edits; the record's stamps are added only on Save. */
export type ProjectSettingsDraft = {
  repos: ProjectRepo[]
  attachments: SessionContextAttachment[]
  agents: ProjectAgent[]
  hostMode: ProjectHostMode
  /** Kept while another mode is picked, so switching back does not lose the picks. */
  hosts: string[]
  company: string
  domain: string
  goal: string
  coordinator: ProjectCoordinatorDraft
  threadDefaults: ProjectCoordinatorDraft
  multiThreadFleet: ProjectThreadLaunch[]
  threadMemories: ProjectThreadMemory[]
}

/** A new project's chat: the launcher's default provider, as a team where that is offered. */
export function defaultCoordinatorDraft(
  defaultAgent: TuiAgent | 'blank' | null | undefined
): ProjectCoordinatorDraft {
  const agent =
    defaultAgent && coordinatorAgentOffered(defaultAgent) ? defaultAgent : COORDINATOR_AGENTS[0]!
  return { agent, team: coordinatorAgentOffersTeam(agent) }
}

export function defaultMultiThreadFleet(): ProjectThreadLaunch[] {
  return [
    {
      agent: 'claude',
      model: 'claude-opus-5-5',
      effort: 'xhigh',
      team: true,
      role: 'Lead Architect & Verifier'
    },
    {
      agent: 'codex',
      model: 'gpt-6-astra',
      effort: 'xhigh',
      team: true,
      role: 'Deep Implementation & Systems'
    },
    {
      agent: 'grok',
      model: 'grok-4',
      effort: 'high',
      role: 'Adversarial Audit & Edge Cases'
    }
  ]
}

export function projectSettingsDraftFor(
  existing: ProjectSettings | null,
  defaultAgent?: TuiAgent | 'blank' | null
): ProjectSettingsDraft {
  const settings = existing ?? emptyProjectSettings(0)
  const policy = settings.hostPolicy
  const recorded = settings.coordinator?.launch
  const recordedThread = settings.threadDefaults
  return {
    repos: settings.repos,
    attachments: settings.attachments,
    agents: settings.agents,
    hostMode: Array.isArray(policy) ? 'hosts' : policy,
    hosts: Array.isArray(policy) ? policy : [],
    company: settings.company ?? '',
    domain: settings.domain ?? '',
    goal: settings.goal ?? '',
    coordinator: recorded
      ? {
          agent: recorded.agent,
          team: recorded.team ?? false,
          ...(recorded.model ? { model: recorded.model } : {}),
          ...(recorded.effort ? { effort: recorded.effort } : {})
        }
      : defaultCoordinatorDraft(defaultAgent),
    threadDefaults: recordedThread
      ? {
          agent: recordedThread.agent,
          team: recordedThread.team ?? false,
          ...(recordedThread.model ? { model: recordedThread.model } : {}),
          ...(recordedThread.effort ? { effort: recordedThread.effort } : {})
        }
      : {
          agent: 'claude',
          model: 'claude-opus-5-5',
          effort: 'high',
          team: true
        },
    multiThreadFleet:
      settings.multiThreadFleet && settings.multiThreadFleet.length > 0
        ? settings.multiThreadFleet
        : defaultMultiThreadFleet(),
    threadMemories: settings.threadMemories ?? []
  }
}

/** The chat's record from the draft; a running chat stays bound. */
export function projectCoordinatorFromDraft(
  draft: ProjectCoordinatorDraft,
  existing: ProjectCoordinator | undefined
): ProjectCoordinator {
  const team = coordinatorAgentOffersTeam(draft.agent) && draft.team
  return {
    launch: {
      agent: draft.agent,
      ...(draft.model ? { model: draft.model } : {}),
      ...(draft.effort ? { effort: draft.effort } : {}),
      ...(team ? { team } : {}),
      // Why not stamped: the Coordinator template applies at start when none is recorded.
      ...(existing?.launch.templateId ? { templateId: existing.launch.templateId } : {})
    },
    ...(existing?.sessionKey ? { sessionKey: existing.sessionKey } : {})
  }
}

export type ProjectSettingsBuild =
  | { ok: true; settings: ProjectSettings }
  | { ok: false; error: string }

/** The record Save writes: a person made it, first stamped when it was first saved. */
export function projectSettingsFromDraft(
  draft: ProjectSettingsDraft,
  existing: ProjectSettings | null,
  now: number
): ProjectSettingsBuild {
  if (draft.hostMode === 'hosts' && draft.hosts.length === 0) {
    return {
      ok: false,
      error: translate(
        'projects.settings.pickComputer',
        'Pick at least one computer, or choose As named or Auto.'
      )
    }
  }
  const company = draft.company.trim()
  const domain = draft.domain.trim()
  const goal = draft.goal.trim()
  const threadTeam =
    coordinatorAgentOffersTeam(draft.threadDefaults.agent) && draft.threadDefaults.team
  return {
    ok: true,
    settings: {
      repos: draft.repos,
      attachments: draft.attachments,
      agents: draft.agents,
      hostPolicy: draft.hostMode === 'hosts' ? draft.hosts : draft.hostMode,
      ...(company ? { company } : {}),
      ...(domain ? { domain } : {}),
      ...(goal ? { goal: goal.slice(0, 1000) } : {}),
      coordinator: projectCoordinatorFromDraft(draft.coordinator, existing?.coordinator),
      threadDefaults: {
        agent: draft.threadDefaults.agent,
        ...(draft.threadDefaults.model ? { model: draft.threadDefaults.model } : {}),
        ...(draft.threadDefaults.effort ? { effort: draft.threadDefaults.effort } : {}),
        ...(threadTeam ? { team: true } : {})
      },
      ...(draft.multiThreadFleet.length > 0
        ? { multiThreadFleet: draft.multiThreadFleet.slice(0, 8) }
        : {}),
      ...(draft.threadMemories.length > 0
        ? { threadMemories: draft.threadMemories.slice(0, 25) }
        : existing?.threadMemories
          ? { threadMemories: existing.threadMemories.slice(0, 25) }
          : {}),
      // Why: the dialog doesn't edit the project's Jira issues, which the page picks.
      ...(existing?.tasks ? { tasks: existing.tasks } : {}),
      createdBy: 'person',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
  }
}

/** Templates a project can carry: Default and empty ones have no text to travel. */
export function projectAgentTemplates(templates: readonly AgentTemplate[]): AgentTemplate[] {
  return templates.filter(
    (template) => template.id !== AGENT_TEMPLATE_DEFAULT_ID && !!template.instructions?.trim()
  )
}

export function withProjectAgent(
  agents: readonly ProjectAgent[],
  template: AgentTemplate
): ProjectAgent[] {
  const agent = projectAgentFor(template)
  if (!agent || agents.some((entry) => entry.templateId === agent.templateId)) {
    return [...agents]
  }
  return [...agents, agent]
}

/** The first agent is the project's default. */
export function withDefaultProjectAgent(
  agents: readonly ProjectAgent[],
  templateId: string
): ProjectAgent[] {
  const chosen = agents.find((agent) => agent.templateId === templateId)
  return chosen ? [chosen, ...agents.filter((agent) => agent !== chosen)] : [...agents]
}

/** The template as it reads now, when its text moved on from the saved copy; else null. */
export function changedProjectAgentTemplate(
  agent: ProjectAgent,
  templates: readonly AgentTemplate[]
): AgentTemplate | null {
  const template = templates.find((entry) => entry.id === agent.templateId)
  if (!template?.instructions?.trim()) {
    return null
  }
  return agentTemplateDigest(template.instructions) === agent.digest ? null : template
}

export function withHostToggled(hosts: readonly string[], hostId: string): string[] {
  return hosts.includes(hostId) ? hosts.filter((id) => id !== hostId) : [...hosts, hostId]
}

export type ProjectRepoChoice = {
  gitIdentity: string
  label: string
  hasRemote: boolean
}

/** One choice per identity; a repo without a remote is listed but cannot be added. */
export function projectRepoChoices(
  repos: readonly Pick<Repo, 'path' | 'displayName' | 'gitRemoteIdentity'>[]
): ProjectRepoChoice[] {
  const byIdentity = new Map<string, ProjectRepoChoice>()
  for (const repo of repos) {
    const gitIdentity = getRepoGitIdentity(repo)
    if (!byIdentity.has(gitIdentity)) {
      byIdentity.set(gitIdentity, {
        gitIdentity,
        label: repo.displayName,
        hasRemote: !gitIdentity.startsWith('path:')
      })
    }
  }
  return [...byIdentity.values()]
}
