import { useState } from 'react'
import { FolderPlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { fileLaunchInFolder } from '@/lib/pending-folder-launches'
import { bindSessionContext } from '@/lib/session-context-store'
import {
  launchHostLabel,
  launchProjectFor,
  projectLaunchHostFor,
  useActiveLaunchProject
} from '@/lib/project-launch'
import {
  refreshProjectLaunchDocuments,
  withFreshProjectDocuments
} from '@/lib/project-launch-documents'
import type { QuickLaunchProject } from '@/hooks/composer-state/quick-launch-options'
import { getRepoGitIdentity } from '../../../../shared/folder-workspace-attached-repos'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  projectLaunchManifest,
  resolveProjectLaunch
} from '../../../../shared/project-launch-inheritance'
import { sessionContextText } from '../../../../shared/session-context-attachments'
import {
  launchManifestReport,
  launchManifestRows,
  projectPointerText,
  sentLaunchAttachments,
  type LaunchManifest
} from '../../../../shared/launch-manifest'

/** The project a new workspace is made for (plan §8 F5); its first session is filed there. */
export type ComposerProject = { folderId: string; name: string }

/** What the workspace's first session inherits, resolved for the host it is created on. */
export async function composerProjectLaunch(
  project: ComposerProject,
  hostId: ExecutionHostId,
  templateId: string | null
): Promise<{
  project: QuickLaunchProject
  onLaunched: (worktreeId: string, tabId: string) => void
} | null> {
  const saved = launchProjectFor(project.folderId)
  if (!saved) {
    return null
  }
  await refreshProjectLaunchDocuments(saved)
  const launchProject = withFreshProjectDocuments(saved)
  const manifest = composerProjectManifest(launchProject, hostId, templateId)
  const attachments = manifest.error ? [] : sentLaunchAttachments(manifest)
  return {
    project: {
      line: manifest.project!.line,
      // Why the pointer here: the composer sends what ComposerProjectLine lists, in the same order.
      context: [
        projectPointerText(manifest.project!, manifest.agent?.templateId),
        sessionContextText(attachments)
      ]
        .filter(Boolean)
        .join('\n\n'),
      agent: manifest.agent
        ? { name: manifest.agent.name, instructions: manifest.agent.instructions }
        : null
    },
    onLaunched: (worktreeId, tabId) => {
      fileLaunchInFolder(tabId, project.folderId)
      bindSessionContext(tabId, worktreeId, attachments)
    }
  }
}

/** What a project's new workspace session gets, as the launch list (launch-manifest.ts). */
function composerProjectManifest(
  launchProject: NonNullable<ReturnType<typeof launchProjectFor>>,
  hostId: ExecutionHostId,
  templateId: string | null
): LaunchManifest & { error: string | null } {
  const host = projectLaunchHostFor(hostId, null)
  const resolution = resolveProjectLaunch({
    project: launchProject,
    launch: [],
    session: [],
    removed: [],
    host,
    templateId
  })
  return {
    ...projectLaunchManifest(
      { ...resolution, project: launchProject },
      { prompt: '', hostLabel: host.label }
    ),
    error: resolution.error
  }
}

/** The project's first repo registered on `hostId`, for the composer to start from. */
export function projectRepoIdOn(folderId: string, hostId: ExecutionHostId): string | undefined {
  const identities = launchProjectFor(folderId)?.settings.repos.map((repo) => repo.gitIdentity)
  const repos = useAppStore.getState().repos
  for (const identity of identities ?? []) {
    const repo = repos.find(
      (entry) =>
        getRepoGitIdentity(entry) === identity.toLowerCase() &&
        getRepoExecutionHostId(entry) === hostId
    )
    if (repo) {
      return repo.id
    }
  }
  return undefined
}

/** The composer's one line naming the project, and what the chosen host lacks from it. */
export function ComposerProjectLine({
  project,
  hostId,
  onClear
}: {
  project: ComposerProject
  hostId: ExecutionHostId | null | undefined
  onClear: () => void
}): React.JSX.Element {
  const host = hostId ?? LOCAL_EXECUTION_HOST_ID
  const launchProject = launchProjectFor(project.folderId)
  const [open, setOpen] = useState(false)
  const manifest = launchProject ? composerProjectManifest(launchProject, host, null) : null
  const missing = manifest?.notOnHost.length ?? 0
  // Why no Task row: the composer's own text box is the task.
  const rows = manifest
    ? launchManifestRows(launchManifestReport(manifest)).filter((row) => row.kind !== 'task')
    : []
  return (
    <div
      className="space-y-1 px-2 text-xs text-muted-foreground"
      data-composer-project={project.folderId}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">
          {translate('projects.composer.line', 'Project: {{name}}', { name: project.name })}
          {missing
            ? translate('projects.composer.notOnHost', ' · {{count}} not on {{host}}', {
                count: missing,
                host: launchHostLabel(host)
              })
            : null}
        </span>
        {rows.length ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto px-1 text-xs text-muted-foreground"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open
              ? translate('projects.composer.hideItems', 'hide')
              : translate('projects.composer.showItems', 'what it adds')}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate('projects.composer.clear', 'Create without the project')}
          onClick={onClear}
        >
          <X className="size-3" />
        </Button>
      </div>
      {open ? (
        <ul className="space-y-0.5" data-composer-project-items>
          {rows.map((row) => (
            <li key={row.id} className="min-w-0 break-words" data-composer-project-item={row.kind}>
              {row.label}: <span className="text-foreground">{row.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** The launcher's "New workspace in <project>…": Orca's Create workspace, carrying the project. */
export function ProjectNewWorkspaceRow({ onClose }: { onClose?: () => void }) {
  const project = useActiveLaunchProject()
  if (!project) {
    return null
  }
  const initialRepoId = projectRepoIdOn(project.folderId, LOCAL_EXECUTION_HOST_ID)
  return (
    <DropdownMenuItem
      data-launcher-project-new-workspace={project.folderId}
      onSelect={() => {
        onClose?.()
        useAppStore.getState().openModal('new-workspace-composer', {
          ...(initialRepoId ? { initialRepoId } : {}),
          project: { folderId: project.folderId, name: project.name },
          telemetrySource: 'sidebar'
        })
      }}
    >
      <FolderPlus className="size-3.5" />
      <span className="min-w-0 flex-1 truncate">
        {translate('projects.launcher.newWorkspace', 'New workspace in {{name}}…', {
          name: project.name
        })}
      </span>
    </DropdownMenuItem>
  )
}
