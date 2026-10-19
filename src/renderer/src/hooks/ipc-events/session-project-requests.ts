import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { listSessionFolderEntries } from '@/lib/session-folder-cli-list'
import { keptLaunchSessionContext } from '@/lib/launch-session-context'
import { bindSessionContext } from '@/lib/session-context-store'
import { sessionProjectForPane } from '@/lib/session-project-for-pane'
import { useSessionFolders } from '@/store/session-folders'
import { openProjectSettings } from '@/components/projects/project-settings-dialog-store'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { resolveSessionFolderRef } from '../../../../shared/session-folder-ref'
import { readProjectFromFolders } from '../../../../shared/session-project-mirror'
import { projectFolderFor } from '../../../../shared/session-project-folder'
import {
  SESSION_PROJECT_REQUEST_KINDS,
  type SessionProjectForPane,
  type SessionProjectListEntry,
  type SessionProjectReadResult,
  type SessionProjectRendererRequest
} from '../../../../shared/session-project-cli'

export function isSessionProjectRequest(request: {
  kind: string
}): request is SessionProjectRendererRequest {
  return SESSION_PROJECT_REQUEST_KINDS.has(request.kind)
}

function findFolder(ref: string) {
  const { metadata } = useSessionFolders.getState()
  const entries = listSessionFolderEntries(metadata, useSessionSidebarView.getState().view)
  const resolved = resolveSessionFolderRef(entries, ref)
  if (!resolved.ok) {
    throw new Error(resolved.error)
  }
  if (resolved.target.kind !== 'folder') {
    throw new Error('Saved Sessions is not a project. Name a folder inside it or elsewhere.')
  }
  const entry = resolved.target.folder
  const project = projectFolderFor(metadata.folders, entry.id)
  const projectEntry = project ? entries.find((candidate) => candidate.id === project.id) : null
  return { metadata, entry, project: projectEntry ?? null }
}

function readProject(
  request: Extract<SessionProjectRendererRequest, { kind: 'readProject' }>
): SessionProjectReadResult {
  const { metadata } = useSessionFolders.getState()
  const entries = listSessionFolderEntries(metadata, useSessionSidebarView.getState().view)
  return {
    ...readProjectFromFolders(entries, metadata.projects ?? {}, request.folder),
    ...(request.worktreeId ? { launch: [...keptLaunchSessionContext(request.worktreeId)] } : {})
  }
}

/** Every project set up in this window; main adds the thread counts. */
function listProjects(): { projects: Omit<SessionProjectListEntry, 'threads'>[] } {
  const { metadata } = useSessionFolders.getState()
  const entries = listSessionFolderEntries(metadata, useSessionSidebarView.getState().view)
  const projects = entries.flatMap((entry) => {
    const settings = metadata.projects?.[entry.id]
    if (!settings) {
      return []
    }
    return [
      {
        folderId: entry.id,
        name: entry.name,
        path: entry.path,
        ...(settings.company ? { company: settings.company } : {}),
        ...(settings.domain ? { domain: settings.domain } : {}),
        repos: settings.repos.length,
        ...(settings.coordinator ? { coordinator: settings.coordinator.launch } : {})
      }
    ]
  })
  return { projects }
}

/** An agent's suggestion reaches the person as a notice; only they can make the project. */
function suggestProject(
  request: Extract<SessionProjectRendererRequest, { kind: 'suggestProject' }>
): { summary: string } {
  const { metadata, entry, project } = findFolder(request.folder)
  if (!project || project.id !== entry.id) {
    throw new Error(
      'Only a top-level folder, or a folder inside a company folder, can be a project. Nothing was suggested.'
    )
  }
  if (metadata.projects?.[project.id]) {
    throw new Error(`“${project.path}” is already a project. Nothing was suggested.`)
  }
  const summary = translate(
    'projects.suggestion.toast',
    '{{by}} suggests making “{{folder}}” a project: {{reason}}',
    { by: request.by, folder: project.path, reason: request.reason }
  )
  toast(summary, {
    duration: 20_000,
    action: {
      label: translate('projects.suggestion.open', 'Set up project'),
      onClick: () => openProjectSettings(project.id)
    }
  })
  return { summary }
}

function createProject(
  request: Extract<SessionProjectRendererRequest, { kind: 'createProject' }>
): SessionProjectReadResult {
  const { entry, project } = findFolder(request.folder)
  if (!project || project.id !== entry.id) {
    throw new Error(
      'Only a top-level folder, or a folder inside a company folder, can be a project.'
    )
  }
  const saved = useSessionFolders.getState().setProjectSettings(project.id, request.settings)
  if (!saved) {
    throw new Error(useSessionFolders.getState().error ?? 'Could not save project settings.')
  }
  return readProject({ kind: 'readProject', folder: project.id })
}

export function answerSessionProjectRequest(
  request: SessionProjectRendererRequest
):
  | SessionProjectReadResult
  | ReturnType<typeof listProjects>
  | SessionProjectForPane
  | { summary: string }
  | { bound: true } {
  switch (request.kind) {
    case 'readProject':
      return readProject(request)
    case 'listProjects':
      return listProjects()
    case 'suggestProject':
      return suggestProject(request)
    case 'createProject':
      return createProject(request)
    case 'projectForPane':
      return { folderId: sessionProjectForPane(useAppStore.getState(), request.paneKey) }
    case 'bindLaunchContext':
      bindSessionContext(request.tabId, request.worktreeId, request.items)
      return { bound: true }
  }
}
