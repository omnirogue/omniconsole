import { projectLaunchManifest } from '../../shared/project-launch-inheritance'
import {
  launchManifestPrompt,
  sentLaunchAttachments,
  type LaunchManifest
} from '../../shared/launch-manifest'
import {
  SESSION_PROJECTS_RPC,
  sessionProjectLaunchReport,
  type SessionProjectLaunch
} from '../../shared/session-project-cli'
import type { SessionContextAttachment } from '../../shared/session-context-attachments'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'

export type ProjectBrief = {
  prompt: string
  /** Everything the session gets; null when the brief launches as given. */
  manifest: LaunchManifest | null
  report: ReturnType<typeof sessionProjectLaunchReport> | null
  warnings: string[]
  /** What the session inherited, kept on its tab after the launch (`bindProjectLaunch`). */
  items: SessionContextAttachment[]
}

/**
 * `omni session launch --folder <project>` (plan §8): the brief the session starts with, as the
 * desktop launcher builds it — the project line, the brief, the project's agent, then everything
 * inherited for the target host. What the host lacks is listed and left out, never dropped
 * silently. An older runtime without projects launches the brief as given, with a warning.
 */
export async function projectBriefForLaunch(
  client: RuntimeClient,
  args: {
    folderId: string
    host: string
    worktree: string
    templateId?: string
    prompt: string
    folderName?: string
  }
): Promise<ProjectBrief> {
  let launch: SessionProjectLaunch | null
  try {
    launch = (
      await client.call<SessionProjectLaunch | null>(SESSION_PROJECTS_RPC.resolveLaunch, {
        folder: args.folderId,
        host: args.host,
        ...(args.worktree.startsWith('id:') ? { worktreeId: args.worktree.slice(3) } : {}),
        ...(args.templateId ? { templateId: args.templateId } : {})
      })
    ).result
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      return {
        prompt: args.prompt,
        manifest: null,
        report: null,
        warnings: [
          'This OmniConsole predates projects; the session did not inherit project settings.'
        ],
        items: []
      }
    }
    throw error
  }
  if (!launch) {
    return { prompt: args.prompt, manifest: null, report: null, warnings: [], items: [] }
  }
  if (launch.error) {
    throw new RuntimeClientError(
      'invalid_argument',
      `The project “${launch.project.name}” gives this session more context than one launch carries: ${launch.error} Remove an attachment from the project or the workspace, then launch again.`
    )
  }
  const manifest = projectLaunchManifest(launch, {
    prompt: args.prompt,
    hostLabel: launch.host.label,
    folder: args.folderName ? { id: args.folderId, name: args.folderName } : null
  })
  return {
    prompt: launchManifestPrompt(manifest),
    manifest,
    report: sessionProjectLaunchReport(launch),
    warnings: [
      ...launch.notOnHost.map(
        (item) =>
          `Not on ${launch.host.label}: ${item.title} (${item.kind}), left out of this session.`
      ),
      ...(launch.notes ?? [])
    ],
    items: sentLaunchAttachments(manifest)
  }
}

/**
 * Keeps the launch's context on its tab, as the desktop launcher does, so a restart re-delivers
 * it and its info panel shows it. A warning when it could not, or null.
 */
export async function bindProjectLaunch(
  client: RuntimeClient,
  terminal: string,
  items: SessionContextAttachment[]
): Promise<string | null> {
  if (!items.length || client.isRemote) {
    return null
  }
  const bound = await client
    .call<{ bound: boolean }>(SESSION_PROJECTS_RPC.bindLaunch, { terminal, items })
    .then((response) => response.result.bound)
    .catch(() => false)
  return bound
    ? null
    : 'The session’s project context is not kept on its tab, so a restart will not re-deliver it.'
}
