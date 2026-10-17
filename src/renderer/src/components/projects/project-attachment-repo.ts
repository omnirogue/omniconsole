import { repoCheckoutOnHost } from '@/lib/project-launch'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectRepo } from '../../../../shared/project-settings'
import type { SessionContextAttachment } from '../../../../shared/session-context-attachments'

/** A repo's checkout on one host, or null when that host has none this window knows of. */
export type RepoCheckoutLookup = (gitIdentity: string, hostId: string) => string | null

// Why the cast: attachments store their host as plain text; the lookup compares it as text too.
const checkoutOnHost: RepoCheckoutLookup = (gitIdentity, hostId) =>
  repoCheckoutOnHost(gitIdentity, hostId as ExecutionHostId)

/**
 * A file or folder picked inside a checkout of one of the project's repos travels by checkout
 * (contract 8): it carries the repo and its path from the root, and each computer opens its own
 * copy. Anything else, and an item already stamped, is returned as it is.
 */
export function withRepoRelativePath(
  item: SessionContextAttachment,
  repos: readonly ProjectRepo[],
  checkoutOf: RepoCheckoutLookup = checkoutOnHost
): SessionContextAttachment {
  if ((item.kind !== 'file' && item.kind !== 'folder') || item.repo || !item.uri) {
    return item
  }
  const hostId = item.hostId ?? LOCAL_EXECUTION_HOST_ID
  for (const repo of repos) {
    const checkout = checkoutOf(repo.gitIdentity, hostId)
    const path = checkout ? relativePathInsideRoot(checkout, item.uri) : null
    if (path !== null) {
      return { ...item, repo: { gitIdentity: repo.gitIdentity, path } }
    }
  }
  return item
}

export function withRepoRelativePaths(
  items: readonly SessionContextAttachment[],
  repos: readonly ProjectRepo[],
  checkoutOf: RepoCheckoutLookup = checkoutOnHost
): SessionContextAttachment[] {
  return items.map((item) => withRepoRelativePath(item, repos, checkoutOf))
}
