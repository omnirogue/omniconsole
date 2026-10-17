import { FolderGit2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import type { FolderGitTarget } from '@/lib/folder-workspace-git-target'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { findRepoOnHost } from '../listing/source-control-host-routing'

/** A folder workspace with no attached repo: say so and point at the one-click attach. */
export function FolderGitTargetNeedsAttach(): React.JSX.Element {
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <FolderGit2 className="size-5 text-muted-foreground" />
      <div className="text-sm font-medium text-foreground">
        {translate('folderGitTarget.needsAttachTitle', 'No repo attached to this folder')}
      </div>
      <div className="max-w-[18rem] text-xs leading-5 text-muted-foreground">
        {translate(
          'folderGitTarget.needsAttachCopy',
          'Attach a repo to see changes, commit and open pull requests here. A repo also attaches the first time a session here creates a worktree for it.'
        )}
      </div>
      <Button size="sm" variant="outline" onClick={() => setRightSidebarTab('workspaces')}>
        {translate('folderGitTarget.attachRepo', 'Attach a repo')}
      </Button>
    </div>
  )
}

/** A repo is attached but its checkout is not loaded here yet: say so, and offer no attach. */
export function FolderGitTargetUnavailable({
  repoNames
}: {
  repoNames: readonly string[]
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <FolderGit2 className="size-5 text-muted-foreground" />
      <div className="text-sm font-medium text-foreground">
        {translate('folderGitTarget.unavailableTitle', 'Waiting for {{names}}', {
          names: repoNames.join(', ')
        })}
      </div>
      <div className="max-w-[18rem] text-xs leading-5 text-muted-foreground">
        {translate(
          'folderGitTarget.unavailableCopy',
          'This folder has a repo attached, but its checkout is not loaded here. It shows once its host is connected and the repo is still set up there.'
        )}
      </div>
    </div>
  )
}

/** The owning host has not said what is attached: never present that as "nothing attached". */
export function FolderGitTargetAttachmentsUnknown({
  failed
}: {
  failed: boolean
}): React.JSX.Element {
  const refresh = useAppStore((s) => s.refreshFolderWorkspaceAttachedRepos)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <FolderGit2 className="size-5 text-muted-foreground" />
      <div className="text-sm font-medium text-foreground">
        {failed
          ? translate(
              'folderGitTarget.attachmentsFailedTitle',
              "Could not load this folder's attached repos"
            )
          : translate('folderGitTarget.attachmentsLoadingTitle', "Loading this folder's repos…")}
      </div>
      {failed ? (
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          {translate('folderGitTarget.retry', 'Try again')}
        </Button>
      ) : null}
    </div>
  )
}

/** Which of the folder's worktrees Source Control shows; the session's own worktrees come first. */
export function FolderGitTargetPicker({
  target
}: {
  target: Extract<FolderGitTarget, { kind: 'target' }>
}): React.JSX.Element {
  const setFolderGitTarget = useAppStore((s) => s.setFolderGitTarget)
  const hostIds = [
    ...new Set(target.candidates.map((c) => c.worktree.hostId ?? LOCAL_EXECUTION_HOST_ID))
  ]
  // Why: when candidates span machines, same-named checkouts are told apart by their host.
  // Why a joined string: a primitive selector result needs no shallow compare.
  const hostLabelList = useAppStore((s) =>
    hostIds.length > 1
      ? hostIds.map((id) => selectExecutionHostDisplayLabel(s, id)).join('\u0000')
      : ''
  )
  const hostLabels = new Map(
    hostLabelList ? hostLabelList.split('\u0000').map((label, i) => [hostIds[i], label]) : []
  )
  const repoNames = useAppStore(
    useShallow((s) =>
      target.candidates.map(
        (c) =>
          (
            findRepoOnHost(s.repos, c.worktree.repoId, c.worktree.hostId) ??
            s.repos.find((repo) => repo.id === c.worktree.repoId)
          )?.displayName ?? ''
      )
    )
  )
  // Why host identity: host-qualified catalogs can repeat a worktree id across hosts.
  const identityOf = (worktree: Worktree): string => getWorktreeHostIdentity(worktree)
  const labelFor = (worktree: Worktree): string => {
    const index = target.candidates.findIndex(
      (c) => identityOf(c.worktree) === identityOf(worktree)
    )
    const repoName = repoNames[index]
    const identity = getWorktreeGitIdentityDisplay(worktree)
    const branch = identity?.kind === 'branch' ? identity.branchName : worktree.displayName
    const host = hostLabels.get(worktree.hostId ?? LOCAL_EXECUTION_HOST_ID)
    return [repoName, branch, host].filter(Boolean).join(' · ')
  }
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      <span className="shrink-0 text-xs text-muted-foreground">
        {translate('folderGitTarget.changesIn', 'Changes in')}
      </span>
      <Select
        value={identityOf(target.worktree)}
        onValueChange={(identity) => setFolderGitTarget(target.folderWorkspaceId, identity)}
      >
        <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-xs">
          <SelectValue>{labelFor(target.worktree)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {target.candidates.map((candidate) => (
            <SelectItem
              key={identityOf(candidate.worktree)}
              value={identityOf(candidate.worktree)}
              className="text-xs"
            >
              {labelFor(candidate.worktree)}
              {candidate.kind === 'repo-checkout'
                ? ` ${translate('folderGitTarget.repoCheckout', '(repo checkout)')}`
                : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
