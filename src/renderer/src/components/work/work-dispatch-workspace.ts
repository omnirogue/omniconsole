import { translate } from '@/i18n/i18n'
import { ensureCompanySessionWorkspace } from '@/lib/company-session-workspace'
import { launchProjectIn, projectWorkspaceIn } from '@/lib/project-launch'
import { sessionPrepDispatchSourceIn } from '@/lib/session-prep-dispatch-source'
import { useSessionFolders } from '@/store/session-folders'
import { useAppStore } from '@/store'

export type WorkDispatchProject = { folderId: string; name: string }

/** A project's ask starts in one of its repos' checkouts; otherwise the company Work root. */
export async function dispatchWorkspace(
  project: WorkDispatchProject | undefined,
  sourceWorktreeId?: string
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  if (sourceWorktreeId) {
    const id = sessionPrepDispatchSourceIn(useAppStore.getState(), sourceWorktreeId)
    return id
      ? { ok: true, id }
      : {
          ok: false,
          message: translate(
            'needSpeed.workspaceUnavailable',
            'Choose a local or SSH workspace to prepare work here.'
          )
        }
  }
  const launch = project
    ? launchProjectIn(useSessionFolders.getState().metadata, project.folderId)
    : null
  const projectWorkspace = launch ? projectWorkspaceIn(useAppStore.getState(), launch) : null
  if (projectWorkspace || launch?.settings.repos.length) {
    const id = projectWorkspace
      ? sessionPrepDispatchSourceIn(useAppStore.getState(), projectWorkspace)
      : null
    return id
      ? { ok: true, id }
      : {
          ok: false,
          message: translate(
            'projects.page.dispatchWorkspaceUnavailable',
            'This project needs a local or SSH checkout to prepare threads here. Use New thread to choose another computer.'
          )
        }
  }
  const prepared = await ensureCompanySessionWorkspace({ company: null, domain: null, agent: null })
  if (!prepared.ok) {
    return {
      ok: false,
      message:
        prepared.reason === 'folder-missing'
          ? translate('work.dispatch.folderMissing', 'The Work folder is missing: {{path}}', {
              path: prepared.path
            })
          : prepared.message
    }
  }
  return { ok: true, id: prepared.workspace.id }
}
