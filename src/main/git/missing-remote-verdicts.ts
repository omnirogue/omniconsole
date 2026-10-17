import { readLocalGitConfigSignature } from '../github/local-git-config-signature'

/**
 * "No such remote" answers per local repo, valid while the repo's Git config files are unchanged.
 * Why: forge probes asked `remote get-url upstream` every few minutes in repos that have no such
 * remote (#857). Adding a remote rewrites `.git/config`, which changes the signature.
 */
const MAX_ENTRIES = 512
const missingRemotes = new Map<string, string>()

function remoteKey(repoPath: string, remoteName: string): string {
  return `${repoPath}\0${remoteName}`
}

/** True when this remote was missing and the repo's config has not changed since. */
export async function isKnownMissingRemote(repoPath: string, remoteName: string): Promise<boolean> {
  const key = remoteKey(repoPath, remoteName)
  const cached = missingRemotes.get(key)
  if (cached === undefined) {
    return false
  }
  const signature = await readLocalGitConfigSignature({ repoPath })
  if (signature !== undefined && signature === cached) {
    return true
  }
  if (missingRemotes.get(key) === cached) {
    missingRemotes.delete(key)
  }
  return false
}

export async function rememberMissingRemote(repoPath: string, remoteName: string): Promise<void> {
  const signature = await readLocalGitConfigSignature({ repoPath })
  // Why: no signature (no local config file found) means no way to notice a remote being added.
  if (signature === undefined) {
    return
  }
  const key = remoteKey(repoPath, remoteName)
  missingRemotes.delete(key)
  missingRemotes.set(key, signature)
  while (missingRemotes.size > MAX_ENTRIES) {
    const oldest = missingRemotes.keys().next().value
    if (typeof oldest !== 'string') {
      break
    }
    missingRemotes.delete(oldest)
  }
}

/** Mirrors git's own failure so callers keep classifying it with isStableMissingGitRemoteError. */
export function missingRemoteError(remoteName: string): Error {
  const stderr = `error: No such remote '${remoteName}'\n`
  return Object.assign(new Error(`Command failed: git remote get-url ${remoteName}\n${stderr}`), {
    code: 2,
    stderr
  })
}

export function _resetMissingRemoteVerdictsForTests(): void {
  missingRemotes.clear()
}
