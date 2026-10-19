/**
 * `omni folder project|project-suggest|project-create` — read a folder's project settings, or
 * suggest a project to the person. Creation is refused for every CLI caller: people make projects
 * in the window (Sal, 2026-09-01), and main names why (session-projects.ts).
 */

import { consoleJiraIssueUrl } from '../../shared/console-jira-work-contract'
import type { ProjectCoordinator } from '../../shared/project-settings'
import { SESSION_MANAGE_RPC, type SessionManageListResult } from '../../shared/session-manage-types'
import {
  SESSION_PROJECTS_RPC,
  type SessionProjectListResult,
  type SessionProjectReadResult,
  type SessionProjectThreadCounts
} from '../../shared/session-project-cli'
import type { SessionProjectThreadStatus } from '../../shared/session-project-thread-status'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { PROJECT_STATUS_LABEL } from '../session-manage-format'

type ThreadStatus = SessionProjectThreadStatus | 'idle'

type ProjectThreadCounts = SessionProjectThreadCounts

const STATUS_ORDER: readonly ThreadStatus[] = [
  ...(Object.keys(PROJECT_STATUS_LABEL) as SessionProjectThreadStatus[]),
  'idle'
]
const statusLabel = (status: ThreadStatus) =>
  status === 'idle' ? 'idle' : PROJECT_STATUS_LABEL[status]

/** Null when the list cannot be read: the settings still print. */
async function projectThreadCounts(
  client: RuntimeClient,
  projectFolderId: string
): Promise<ProjectThreadCounts | null> {
  const listed = await client
    .call<SessionManageListResult>(SESSION_MANAGE_RPC.list, { project: projectFolderId })
    .then((response) => response.result)
    .catch(() => null)
  // Why: an older runtime ignores `project` and lists every session.
  if (!listed?.scope?.project) {
    return null
  }
  const counts: ProjectThreadCounts = { total: 0, byStatus: {} }
  for (const entry of listed.sessions) {
    const status = entry.projectStatus ?? 'idle'
    if (entry.projectCoordinator) {
      counts.chat = status
      continue
    }
    counts.total += 1
    counts.byStatus[status] = (counts.byStatus[status] ?? 0) + 1
  }
  return counts
}

function coordinatorLine(
  coordinator: ProjectCoordinator | undefined,
  threads: ProjectThreadCounts | undefined
): string[] {
  if (!coordinator) {
    return []
  }
  const { launch } = coordinator
  const pick = [
    launch.agent,
    launch.model,
    launch.effort ? `effort ${launch.effort}` : null,
    launch.team ? 'team' : null
  ]
  const chat = threads?.chat ? `chat ${statusLabel(threads.chat)}` : threads ? 'not running' : null
  return [`  coordinator ${[...pick, chat].filter(Boolean).join(' · ')}`]
}

function threadsLine(threads: ProjectThreadCounts | undefined): string[] {
  if (!threads) {
    return []
  }
  const parts = STATUS_ORDER.flatMap((status) =>
    threads.byStatus[status] ? [`${threads.byStatus[status]} ${statusLabel(status)}`] : []
  )
  return [`  threads ${threads.total}${parts.length ? `: ${parts.join(', ')}` : ''}`]
}

function refuseRemote(client: RuntimeClient): void {
  if (client.isRemote) {
    throw new RuntimeClientError(
      'permission_denied',
      'Projects can only be read by the omni CLI on the computer running OmniConsole.'
    )
  }
}

function formatProject(
  result: SessionProjectReadResult & { threads?: ProjectThreadCounts }
): string {
  const { project } = result
  if (!project) {
    return `“${result.folder.path}” is in no project. A top-level folder, or one inside a company folder, can become one.`
  }
  if (!project.settings) {
    return `“${project.path}” can be a project but has no project settings yet.`
  }
  const { settings } = project
  return [
    `Project ${project.path}  id ${project.folderId}`,
    ...(settings.company || settings.domain
      ? [`  company ${settings.company ?? '-'} · domain ${settings.domain ?? '-'}`]
      : []),
    ...settings.repos.map((repo) => `  repo ${repo.gitIdentity}`),
    ...settings.attachments.map(
      (item) =>
        `  ${item.kind} ${item.title}${item.notes ? ' (notes)' : ''}${item.hostId ? ` (on ${item.hostId})` : ''}`
    ),
    ...settings.agents.map(
      (agent, index) => `  agent ${agent.name}${index === 0 ? ' (default)' : ''}`
    ),
    `  computers ${Array.isArray(settings.hostPolicy) ? settings.hostPolicy.join(', ') : settings.hostPolicy}`,
    ...coordinatorLine(settings.coordinator, result.threads),
    ...threadsLine(result.threads),
    ...(settings.tasks ?? []).map((ref) =>
      [`  issue ${ref.issue_key}`, consoleJiraIssueUrl(ref)].filter(Boolean).join(' ')
    )
  ].join('\n')
}

function formatProjectList(result: SessionProjectListResult): string {
  if (!result.projects.length) {
    return 'No projects on this computer. A person sets a folder up as one in OmniConsole.'
  }
  return result.projects
    .flatMap((project) => [
      `${project.path}  id ${project.folderId}  repos ${project.repos}`,
      ...coordinatorLine(
        project.coordinator ? { launch: project.coordinator } : undefined,
        project.threads ?? undefined
      ),
      ...threadsLine(project.threads ?? undefined)
    ])
    .join('\n')
}

/** `terminal create --folder` files a plain terminal without the project's brief; names the doors that inherit. */
export async function projectTerminalWarning(
  client: RuntimeClient,
  folderId: string
): Promise<string | null> {
  const read = await client
    .call<SessionProjectReadResult>(SESSION_PROJECTS_RPC.show, { folder: folderId })
    .then((response) => response.result)
    .catch(() => null)
  const project = read?.project
  return project?.settings
    ? `“${project.name}” is a project, but a terminal made with --folder does not inherit it. For a thread that does, use omni session launch --folder ${folderId} or omni orchestration worker-start --project ${folderId}.`
    : null
}

export const SESSION_PROJECT_HANDLERS: Record<string, CommandHandler> = {
  // Why remote is allowed: a paired desktop lists this computer's projects to dispatch into one.
  'folder projects': async ({ client, json }) => {
    const response = await client.call<SessionProjectListResult>(SESSION_PROJECTS_RPC.list, {})
    printResult(response, json, formatProjectList)
  },
  'folder project': async ({ client, flags, json }) => {
    refuseRemote(client)
    const response = await client.call<SessionProjectReadResult>(SESSION_PROJECTS_RPC.show, {
      folder: getRequiredStringFlag(flags, 'folder')
    })
    const { project } = response.result
    const threads = project?.settings ? await projectThreadCounts(client, project.folderId) : null
    printResult(
      threads ? { ...response, result: { ...response.result, threads } } : response,
      json,
      formatProject
    )
  },
  'folder project-suggest': async ({ client, flags, json }) => {
    refuseRemote(client)
    const response = await client.call<{ summary: string }>(SESSION_PROJECTS_RPC.suggest, {
      folder: getRequiredStringFlag(flags, 'folder'),
      reason: getRequiredStringFlag(flags, 'reason')
    })
    printResult(response, json, (value) => `Suggested to the person: ${value.summary}`)
  },
  'folder project-create': async ({ client, flags }) => {
    refuseRemote(client)
    // Why call main: its caller detection names who was refused; it never creates one.
    await client.call(SESSION_PROJECTS_RPC.create, {
      folder: getRequiredStringFlag(flags, 'folder')
    })
  }
}
