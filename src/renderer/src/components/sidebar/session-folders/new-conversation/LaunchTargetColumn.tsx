import { Fragment, useMemo } from 'react'
import { Folder, FolderGit2, FolderPlus, GitBranch, Home, Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  AGENT_DETECTION_LOCAL_TARGET_KEY,
  getAgentDetectionTargetKeyForWorktree
} from '@/hooks/useAgentDetectionTarget'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { isWslUncPath } from '../../../../../../shared/wsl-paths'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { LOCAL_OLLAMA_MEMORY_ROOT_KEY } from '../../../../../../shared/local-ollama-launch'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getFolderWorkspaceIdentity, groupSessionWorktrees } from '@/lib/session-worktree-grouping'
import {
  partitionLaunchTargetOptions,
  type LaunchTarget,
  type TargetOption
} from './launch-target-options'

export type { LaunchTarget } from './launch-target-options'

const EMPTY_REPOS: never[] = []
const EMPTY_WORKTREES: Record<string, never[]> = {}
const EMPTY_FOLDERS: never[] = []

// Why: the launcher's rows exist only for launches on this machine: the same resolver that
// computes `local` (SSH, runtime, ambiguous and unresolved hosts out), and no WSL runtime,
// since a Windows-side Ollama is not reachable from inside WSL by default.
function targetPath(worktreeId: string): string | undefined {
  const state = useAppStore.getState()
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return state.folderWorkspaces?.find((entry) => entry.id === scope.folderWorkspaceId)?.folderPath
  }
  return state.getKnownWorktreeById(worktreeId)?.path
}

export function isLocalLaunchTarget(worktreeId: string | null, path?: string): boolean {
  if (worktreeId === null) {
    return true
  }
  const state = useAppStore.getState()
  if (
    getAgentDetectionTargetKeyForWorktree(state, worktreeId) !== AGENT_DETECTION_LOCAL_TARGET_KEY
  ) {
    return false
  }
  const resolvedPath = path ?? targetPath(worktreeId)
  if (resolvedPath && isWslUncPath(resolvedPath)) {
    return false
  }
  // Why: the runtime resolver knows worktrees only; for a folder it would fall back to the
  // active repo, so a folder is judged by its path alone.
  if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
    return true
  }
  const runtime = getLocalProjectExecutionRuntimeContext(state, worktreeId)
  if (runtime?.status === 'resolved' && runtime.runtime.kind === 'wsl') {
    return false
  }
  return !(runtime?.status === 'repair-required' && runtime.repair.preferredRuntime.kind === 'wsl')
}

/** Every place a session can start: the Work root, each repo worktree, each folder workspace. */
export function useLaunchTargetOptions(): TargetOption[] {
  const repos = useAppStore((state) => state.repos ?? EMPTY_REPOS)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo ?? EMPTY_WORKTREES)
  const folderWorkspaces = useAppStore((state) => state.folderWorkspaces ?? EMPTY_FOLDERS)
  const groupSessionWorktreesEnabled = useAppStore((state) => state.groupSessionWorktrees)
  const worktreeLineageById = useAppStore((state) => state.worktreeLineageById)
  const workspaceLineageByChildKey = useAppStore((state) => state.workspaceLineageByChildKey)
  return useMemo(() => {
    const localWorktrees = repos.flatMap((repo) =>
      (worktreesByRepo[repo.id] ?? []).filter((worktree) =>
        isLocalLaunchTarget(worktree.id, worktree.path)
      )
    )
    const grouping = groupSessionWorktreesEnabled
      ? groupSessionWorktrees({
          worktrees: localWorktrees,
          worktreeLineageById,
          workspaceLineageByChildKey,
          folderWorkspaceIdentities: new Set(
            folderWorkspaces.map((workspace) =>
              getFolderWorkspaceIdentity(workspace.executionHostId, workspace.id)
            )
          )
        })
      : null
    const placementOf = (worktree: Worktree): TargetOption['placement'] => {
      const placement = grouping?.placementByIdentity.get(getWorktreeHostIdentity(worktree))
      if (!placement || placement.kind === 'top-level') {
        return { kind: 'top-level' }
      }
      if (placement.kind === 'nested') {
        const root = localWorktrees.find(
          (candidate) => getWorktreeHostIdentity(candidate) === placement.rootIdentity
        )
        return root ? { kind: 'under', parentKey: root.id } : { kind: 'existing' }
      }
      if (placement.kind === 'folder') {
        return { kind: 'under', parentKey: folderWorkspaceKey(placement.folderWorkspaceId) }
      }
      return { kind: 'existing' }
    }
    const options: TargetOption[] = [
      {
        target: { kind: 'work-root' },
        key: LOCAL_OLLAMA_MEMORY_ROOT_KEY,
        name: translate('localOllama.target.workRoot', 'Work root'),
        detail: translate(
          'localOllama.target.workRootDetail',
          'A fresh session folder, no repository'
        ),
        kind: 'root',
        placement: { kind: 'top-level' }
      }
    ]
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))
    for (const worktree of localWorktrees) {
      const repo = repoById.get(worktree.repoId)
      if (repo) {
        options.push({
          target: { kind: 'workspace', worktreeId: worktree.id },
          key: worktree.id,
          name:
            worktree.displayName && worktree.displayName !== repo.displayName
              ? `${repo.displayName} · ${worktree.displayName}`
              : repo.displayName,
          detail: worktree.path,
          kind: repo.kind === 'folder' ? 'folder' : 'repo',
          placement: placementOf(worktree)
        })
      }
    }
    for (const workspace of folderWorkspaces) {
      const key = folderWorkspaceKey(workspace.id)
      if (!isLocalLaunchTarget(key, workspace.folderPath)) {
        continue
      }
      options.push({
        target: { kind: 'workspace', worktreeId: key },
        key,
        name: workspace.name,
        detail: workspace.folderPath,
        kind: 'folder',
        placement: { kind: 'top-level' }
      })
    }
    return options
  }, [
    repos,
    worktreesByRepo,
    folderWorkspaces,
    groupSessionWorktreesEnabled,
    worktreeLineageById,
    workspaceLineageByChildKey
  ])
}

function TargetIcon({ kind }: { kind: TargetOption['kind'] }): React.JSX.Element {
  if (kind === 'repo') {
    return <FolderGit2 className="size-3.5" />
  }
  if (kind === 'folder') {
    return <Folder className="size-3.5" />
  }
  return <Home className="size-3.5" />
}

export function LaunchTargetColumn({
  options,
  selectedKey,
  onSelect,
  onClose
}: {
  options: TargetOption[]
  selectedKey: string
  onSelect: (target: LaunchTarget) => void
  onClose: () => void
}): React.JSX.Element {
  const openModal = useAppStore((state) => state.openModal)
  const { topLevel, childrenByParentKey, existing } = useMemo(
    () => partitionLaunchTargetOptions(options, selectedKey),
    [options, selectedKey]
  )
  const renderOption = (option: TargetOption): React.JSX.Element => (
    <DropdownMenuItem
      key={option.key}
      onSelect={(event) => {
        // Why: picking a target is a refinement; the picker stays open for the agent choice.
        event.preventDefault()
        onSelect(option.target)
      }}
    >
      <TargetIcon kind={option.kind} />
      <div className="min-w-0 flex-1">
        <div className="truncate">{option.name}</div>
        <div className="truncate text-xs text-muted-foreground">{option.detail}</div>
      </div>
      {option.key === selectedKey ? (
        <span className="text-xs text-muted-foreground">
          {translate('localOllama.target.current', 'Current')}
        </span>
      ) : null}
    </DropdownMenuItem>
  )
  const renderGroup = (
    key: string,
    label: string,
    children: readonly TargetOption[],
    indent: boolean
  ): React.JSX.Element => (
    <DropdownMenuSub key={key}>
      <DropdownMenuSubTrigger className={indent ? 'pl-7' : undefined}>
        <GitBranch className="size-3.5" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72 max-h-96 overflow-y-auto scrollbar-sleek">
        {children.map(renderOption)}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
  return (
    <>
      <DropdownMenuLabel>{translate('localOllama.target.title', 'Launch in')}</DropdownMenuLabel>
      {topLevel.map((option) => {
        const children = childrenByParentKey.get(option.key)
        return (
          <Fragment key={option.key}>
            {renderOption(option)}
            {children && children.length > 0
              ? renderGroup(
                  `children:${option.key}`,
                  translate('localOllama.target.childWorktrees', '{{count}} worktrees', {
                    count: children.length
                  }),
                  children,
                  true
                )
              : null}
          </Fragment>
        )
      })}
      {existing.length > 0
        ? renderGroup(
            'existing-worktrees',
            translate('localOllama.target.existingWorktrees', 'Existing worktrees ({{count}})', {
              count: existing.length
            }),
            existing,
            false
          )
        : null}
      <DropdownMenuSeparator />
      <DropdownMenuLabel>
        {translate('localOllama.target.add', 'Add a place to work')}
      </DropdownMenuLabel>
      <DropdownMenuItem
        onSelect={() => {
          onClose()
          openModal('new-workspace-composer', { telemetrySource: 'unknown' })
        }}
      >
        <FolderPlus className="size-3.5" />
        <div className="min-w-0 flex-1">
          <div>{translate('localOllama.target.newWorkspace', 'New workspace…')}</div>
          <div className="truncate text-xs text-muted-foreground">
            {translate(
              'localOllama.target.newWorkspaceDetail',
              'A branch of a repository, or a folder of files'
            )}
          </div>
        </div>
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          onClose()
          openModal('add-repo')
        }}
      >
        <Plus className="size-3.5" />
        <div className="min-w-0 flex-1">
          <div>{translate('localOllama.target.addProject', 'Add a project…')}</div>
          <div className="truncate text-xs text-muted-foreground">
            {translate(
              'localOllama.target.addProjectDetail',
              'Browse a folder, clone from a Git URL, or create a new project'
            )}
          </div>
        </div>
      </DropdownMenuItem>
    </>
  )
}
