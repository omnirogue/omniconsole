import { normalizeGitRemoteUrl } from '../../shared/git-remote-identity'

/** Foreman owner/repo slugs explicitly name GitHub; host-qualified jobs retain their host. */
export function consoleJobRepositoryIdentity(repo: string): string | null {
  const value = repo.trim()
  if (value.split('/').some((part) => part === '.' || part === '..')) {
    return null
  }
  const remote = normalizeGitRemoteUrl(value)
  if (remote) {
    return remote.toLowerCase()
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    return normalizeGitRemoteUrl(`https://github.com/${value}`)?.toLowerCase() ?? null
  }
  if (/^[A-Za-z0-9.-]+\.[A-Za-z0-9.-]+\/[^\s]+\//.test(value)) {
    return normalizeGitRemoteUrl(`https://${value}`)?.toLowerCase() ?? null
  }
  return null
}
