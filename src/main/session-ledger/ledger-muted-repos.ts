import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureJsonFile } from '../../shared/secure-file'
import { readProfileIndex } from '../omni-profiles/profile-index-store'
import {
  getOrcaProfileDirectory,
  getOrcaProfileIndexPath,
  getProfileUserDataPath
} from '../omni-profiles/profile-storage-paths'

const MUTED_REPOS_FILE_NAME = 'session-ledger-muted-repos.json'
const MUTED_REPOS_MAX = 200

type MutedReposFile = { version: 1; repos: string[] }

/** The banner mute lives with the profile's other preferences, so switching profiles switches mutes. */
export function mutedReposFilePath(userDataPath = getProfileUserDataPath()): string {
  const index = readProfileIndex(getOrcaProfileIndexPath(userDataPath))
  const profileId = index?.activeProfileId ?? 'default'
  return join(getOrcaProfileDirectory(profileId, userDataPath), MUTED_REPOS_FILE_NAME)
}

export function parseMutedRepos(value: unknown): string[] {
  const record = value as Partial<MutedReposFile> | null
  if (!record || typeof record !== 'object' || !Array.isArray(record.repos)) {
    return []
  }
  return [
    ...new Set(record.repos.filter((repo) => typeof repo === 'string' && repo.length > 0))
  ].slice(0, MUTED_REPOS_MAX)
}

export function readMutedRepos(path = mutedReposFilePath()): string[] {
  try {
    return existsSync(path) ? parseMutedRepos(JSON.parse(readFileSync(path, 'utf8'))) : []
  } catch {
    return []
  }
}

export function writeMutedRepos(repos: string[], path = mutedReposFilePath()): void {
  const file: MutedReposFile = { version: 1, repos: parseMutedRepos({ repos }) }
  writeSecureJsonFile(path, file)
}

/** `repo` is the normalized remote identity the rows carry; it is matched verbatim (no case folding). */
export function setRepoMuted(repo: string, muted: boolean, path = mutedReposFilePath()): string[] {
  const key = repo.trim()
  const current = readMutedRepos(path).filter((entry) => entry !== key)
  const next = muted ? [...current, key] : current
  writeMutedRepos(next, path)
  return next
}
