import { useEffect, useState } from 'react'
import { FolderGit2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { FolderWorkspaceRepoCandidate } from '../../../../shared/folder-workspace-repo-candidates'
import { getRuntimeEnvironmentIdForFolderWorkspace } from '@/lib/folder-workspace-runtime-owner'
import {
  selectFolderWorkspaceAttachedRepos,
  selectFolderWorkspaceAttachedReposStatus
} from '@/store/folder-workspaces/folder-workspace-attached-repo-actions'

/**
 * The repos this folder works on, plus one-click offers for git checkouts found inside it.
 * A repo also attaches on its own the first time a session here creates a worktree for it.
 */
export function FolderWorkspaceAttachedRepos({
  folderWorkspace
}: {
  folderWorkspace: FolderWorkspace
}): React.JSX.Element {
  const attached = useAppStore((s) => selectFolderWorkspaceAttachedRepos(s, folderWorkspace.id))
  const attachedStatus = useAppStore((s) =>
    selectFolderWorkspaceAttachedReposStatus(s, folderWorkspace.id)
  )
  const detect = useAppStore((s) => s.detectFolderWorkspaceRepos)
  const attach = useAppStore((s) => s.attachFolderWorkspaceRepo)
  const detach = useAppStore((s) => s.detachFolderWorkspaceRepo)
  const addRepoPath = useAppStore((s) => s.addRepoPath)
  const refreshAttached = useAppStore((s) => s.refreshFolderWorkspaceAttachedRepos)
  const [detection, setDetection] = useState<
    | { status: 'loading' }
    | { status: 'ready'; candidates: FolderWorkspaceRepoCandidate[]; incomplete: boolean }
    | { status: 'error'; message: string }
  >({ status: 'loading' })
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [scanAttempt, setScanAttempt] = useState(0)
  const attachedCount = attached.length

  useEffect(() => {
    let cancelled = false
    detect(folderWorkspace.id)
      .then((found) => {
        if (!cancelled) {
          setDetection({ status: 'ready', ...found })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDetection({
            status: 'error',
            message: err instanceof Error ? err.message : String(err)
          })
        }
      })
    return () => {
      cancelled = true
    }
    // Why attachedCount: re-detect after an attach or detach so offers stay in sync.
  }, [detect, folderWorkspace.id, attachedCount, scanAttempt])

  const offers =
    detection.status === 'ready'
      ? detection.candidates.filter((candidate) => !candidate.attached)
      : []

  const attachCandidate = async (candidate: FolderWorkspaceRepoCandidate): Promise<void> => {
    setBusyPath(candidate.path)
    try {
      let repoId = candidate.registeredRepoId
      if (!repoId) {
        // Why: register on the host that owns this folder, never whichever runtime is focused.
        const added = await addRepoPath(candidate.path, 'git', {
          runtimeEnvironmentId: getRuntimeEnvironmentIdForFolderWorkspace(
            useAppStore.getState(),
            folderWorkspace.id
          )
        })
        repoId = added?.id ?? null
      }
      if (
        !repoId ||
        !(await attach({
          folderWorkspaceId: folderWorkspace.id,
          repoId,
          source: 'detected-checkout'
        }))
      ) {
        throw new Error('attach_failed')
      }
    } catch (err) {
      console.warn('Failed to attach repo to folder workspace:', err)
      toast.error(
        translate('folderWorkspace.attachedRepos.attachFailed', 'Could not attach {{name}}.', {
          name: candidate.displayName
        })
      )
    } finally {
      setBusyPath(null)
    }
  }

  const detachEntry = async (key: string, name: string): Promise<void> => {
    try {
      if (!(await detach(folderWorkspace.id, key))) {
        throw new Error('detach_failed')
      }
    } catch (err) {
      console.warn('Failed to detach repo from folder workspace:', err)
      toast.error(
        translate('folderWorkspace.attachedRepos.detachFailed', 'Could not detach {{name}}.', {
          name
        })
      )
      void refreshAttached()
    }
  }

  return (
    <div className="border-b border-border px-4 py-3" data-testid="folder-attached-repos">
      <div className="text-xs font-medium text-muted-foreground">
        {translate('folderWorkspace.attachedRepos.title', 'Repos')}
      </div>
      {detection.status === 'error' ? (
        <div className="mt-1 text-xs leading-5 text-muted-foreground">
          {translate(
            'folderWorkspace.attachedRepos.scanFailed',
            'Could not look for repos in this folder: {{reason}}',
            { reason: detection.message }
          )}{' '}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => {
              setDetection({ status: 'loading' })
              setScanAttempt((attempt) => attempt + 1)
            }}
          >
            {translate('folderWorkspace.attachedRepos.retry', 'Try again')}
          </button>
        </div>
      ) : null}
      {detection.status === 'ready' && detection.incomplete ? (
        <div className="mt-1 text-xs leading-5 text-muted-foreground">
          {translate(
            'folderWorkspace.attachedRepos.scanIncomplete',
            'The search stopped early, so some checkouts in this folder may not be listed.'
          )}
        </div>
      ) : null}
      {attachedStatus === 'failed' ? (
        <div className="mt-1 text-xs leading-5 text-muted-foreground">
          {translate(
            'folderWorkspace.attachedRepos.loadFailed',
            "Could not load this folder's attached repos."
          )}{' '}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => void refreshAttached()}
          >
            {translate('folderWorkspace.attachedRepos.retry', 'Try again')}
          </button>
        </div>
      ) : null}
      {attachedStatus === 'ready' &&
      attached.length === 0 &&
      offers.length === 0 &&
      detection.status === 'ready' ? (
        <div className="mt-1 text-xs leading-5 text-muted-foreground">
          {translate(
            'folderWorkspace.attachedRepos.empty',
            'No repo attached yet. One attaches the first time a session here creates a worktree for it.'
          )}
        </div>
      ) : null}
      {attached.map((entry) => (
        <div key={entry.key} className="group mt-1.5 flex items-center gap-2 text-sm">
          <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-foreground">{entry.displayName}</div>
            <div className="truncate text-xs text-muted-foreground">{entry.repoPath}</div>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={translate('folderWorkspace.attachedRepos.detach', 'Detach {{name}}', {
              name: entry.displayName
            })}
            onClick={() => void detachEntry(entry.key, entry.displayName)}
          >
            <X className="size-3" />
          </Button>
        </div>
      ))}
      {offers.map((candidate) => {
        // Why: a remote checkout must be added as a project on its host before it can attach.
        const needsRemoteProject = !candidate.registeredRepoId && candidate.connectionId !== null
        return (
          <div key={candidate.path} className="mt-1.5 flex items-center gap-2 text-sm">
            <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-foreground">
                {translate('folderWorkspace.attachedRepos.offer', 'Attach {{name}}?', {
                  name: candidate.displayName
                })}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {needsRemoteProject
                  ? translate(
                      'folderWorkspace.attachedRepos.offerRemote',
                      'Add this checkout as a project on its host first.'
                    )
                  : candidate.path}
              </div>
            </div>
            <Button
              variant="outline"
              size="xs"
              disabled={needsRemoteProject || busyPath !== null}
              onClick={() => void attachCandidate(candidate)}
            >
              <Plus className="size-3" />
              {translate('folderWorkspace.attachedRepos.attach', 'Attach')}
            </Button>
          </div>
        )
      })}
    </div>
  )
}
