import { translate } from '@/i18n/i18n'
import { SourceControlPanelReady } from './panel-ready'
import { useSourceControlPanelModel } from './use-panel-model'
import { useFolderGitTarget } from '../listing/use-source-control-target'
import {
  FolderGitTargetAttachmentsUnknown,
  FolderGitTargetNeedsAttach,
  FolderGitTargetPicker,
  FolderGitTargetUnavailable
} from './folder-git-target'

/** Resolves the panel model and guards the two states that have no source control to show. */
export function SourceControlPanel() {
  const model = useSourceControlPanelModel()
  const folderTarget = useFolderGitTarget()
  const { activeRepo, activeWorktree, isFolder, worktreePath } = model

  if (folderTarget.kind === 'needs-attach') {
    return <FolderGitTargetNeedsAttach />
  }
  if (folderTarget.kind === 'attachments-unknown') {
    return <FolderGitTargetAttachmentsUnknown failed={folderTarget.failed} />
  }
  if (folderTarget.kind === 'unavailable') {
    return <FolderGitTargetUnavailable repoNames={folderTarget.repoNames} />
  }

  if (!activeWorktree || !activeRepo || !worktreePath) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground px-4 text-center">
        {translate(
          'auto.components.right.sidebar.SourceControl.c07b236287',
          'Select a workspace to view changes'
        )}
      </div>
    )
  }
  if (isFolder) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground px-4 text-center">
        {translate(
          'auto.components.right.sidebar.SourceControl.e131cd7128',
          'Source Control is only available for Git repositories'
        )}
      </div>
    )
  }

  const ready = (
    <SourceControlPanelReady
      activeRepo={activeRepo}
      activeWorktree={activeWorktree}
      currentWorktreeId={activeWorktree.id}
      model={model}
      worktreePath={worktreePath}
    />
  )
  return folderTarget.kind === 'target' ? (
    <div className="flex h-full min-h-0 flex-col">
      <FolderGitTargetPicker target={folderTarget} />
      <div className="min-h-0 flex-1">{ready}</div>
    </div>
  ) : (
    ready
  )
}
