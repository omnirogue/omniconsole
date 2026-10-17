import { RuntimeClientError } from './runtime-client'
import type { CommandHandler } from './dispatch'
import { parseWorkspaceKey } from '../shared/workspace-scope'

type FolderRepoResolution =
  | { kind: 'resolved'; repoSelector: string; displayName: string }
  | { kind: 'fallthrough' }
  | { kind: 'error'; code?: string; message: string }

const FOLDER_UNDECIDED_ERRORS = new WeakSet<object>()

/** The folder workspace a create is parented to, from --parent-workspace or the session env. */
export function getFolderParentWorkspace(
  ...candidates: (string | undefined)[]
): string | undefined {
  return candidates.find(
    (candidate) => candidate && parseWorkspaceKey(candidate)?.type === 'folder'
  )
}

/**
 * Resolves the create's repo through the folder workspace's attached repos. Undefined means
 * "use the ordinary lookup": no folder parent, a name that is not attached yet, or an older host.
 */
export async function resolveFolderWorkspaceCreateRepo(
  client: Parameters<CommandHandler>[0]['client'],
  folderWorkspace: string | undefined,
  repo: string | undefined,
  cwdRepoSelector?: string
): Promise<string | undefined> {
  if (!folderWorkspace) {
    return undefined
  }
  let resolution: FolderRepoResolution
  try {
    const response = await client.call<{ resolution: FolderRepoResolution }>(
      'folderWorkspace.resolveRepoForCreate',
      {
        folderWorkspace,
        ...(repo ? { repo } : {}),
        ...(cwdRepoSelector?.startsWith('id:') ? { cwdRepoId: cwdRepoSelector.slice(3) } : {})
      }
    )
    resolution = response.result.resolution
  } catch (error) {
    // Why: a host from before attached repos has no such method; keep its old behavior.
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      return undefined
    }
    throw error
  }
  if (resolution.kind === 'error') {
    const error = new RuntimeClientError('invalid_argument', resolution.message)
    // Why: only "the folder cannot decide" may fall back to the cwd repo; anything else stops here.
    if (resolution.code === 'ambiguous' || resolution.code === 'none-attached') {
      FOLDER_UNDECIDED_ERRORS.add(error)
    }
    throw error
  }
  return resolution.kind === 'resolved' ? resolution.repoSelector : undefined
}

/** `id:<repoId>::<path>` → `id:<repoId>`: the repo of the worktree the command runs in. */
export function getRepoSelectorFromWorktreeSelector(
  selector: string | undefined
): string | undefined {
  if (!selector?.startsWith('id:')) {
    return undefined
  }
  const worktreeId = selector.slice('id:'.length)
  const separatorIndex = worktreeId.indexOf('::')
  if (separatorIndex <= 0) {
    return undefined
  }
  return `id:${worktreeId.slice(0, separatorIndex)}`
}

/**
 * The create's repo, in order: the --project target, an explicit --repo (resolved through the
 * folder's attached repos first), the folder's attached repos (the cwd repo wins when it is one
 * of them), then the repo of the worktree the command runs in.
 */
export async function resolveCreateRepoSelector(args: {
  client: Parameters<CommandHandler>[0]['client']
  projectRepoSelector: string | undefined
  explicitRepo: string | undefined
  cwdParentWorktree: string | undefined
  folderParentWorkspace: string | undefined
}): Promise<string> {
  const { client, explicitRepo, folderParentWorkspace } = args
  if (args.projectRepoSelector) {
    return args.projectRepoSelector
  }
  if (explicitRepo) {
    // Why: an id: or path: selector already names one repo; only a bare name can mean an attached one.
    if (/^(id|path):/.test(explicitRepo)) {
      return explicitRepo
    }
    return (
      (await resolveFolderWorkspaceCreateRepo(client, folderParentWorkspace, explicitRepo)) ??
      explicitRepo
    )
  }
  const inferredRepo = getRepoSelectorFromWorktreeSelector(args.cwdParentWorktree)
  try {
    const attachedRepo = await resolveFolderWorkspaceCreateRepo(
      client,
      folderParentWorkspace,
      undefined,
      inferredRepo
    )
    if (attachedRepo) {
      return attachedRepo
    }
  } catch (error) {
    // Why: when the folder cannot decide (none or several attached), the cwd repo still can;
    // a transport failure or a stale attachment must stop the create instead.
    if (!inferredRepo || !FOLDER_UNDECIDED_ERRORS.has(error as object)) {
      throw error
    }
  }
  if (inferredRepo) {
    return inferredRepo
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'Missing repo selector. Pass --repo or run from inside an OmniConsole-managed worktree.'
  )
}
