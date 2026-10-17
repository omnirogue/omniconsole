/**
 * The workspace a moved session resumes in on the claiming computer (PLAN section 4): its own
 * `~/Work` folder, or a worktree of this computer's clone of the same repository on the session's
 * pushed branch at exactly the commit it slept on. Finding one changes nothing; preparing it may
 * create a local branch at that commit and a worktree, through the runtime's own create.
 */

import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, isAbsolute } from 'node:path'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { isFolderRepo } from '../../shared/repo-kind'
import { gitExecFileAsync } from '../git/runner'
import type { WakeCopyHeader, WakeCopyWorkspace } from './review-wake-copy-pack'
import { listedHead, WAKE_COPY_GIT_NETWORK_TIMEOUT_MS } from './review-wake-copy-source'
import { GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS } from '../../shared/git-fetch-auto-maintenance'
import { isRelocationManifestPath } from '../../shared/session-host-payload-schema'
import { isWslUncPath } from '../../shared/wsl-paths'

async function git(cwd: string, args: string[], network?: { timeout: number }): Promise<string> {
  return (
    await gitExecFileAsync(args, {
      cwd,
      // Why background: a move is never what a person is waiting on, and it must not hang the pass.
      admissionTier: 'background',
      ...(network ? { timeout: network.timeout, useConfiguredSshCommandForNetwork: true } : {})
    })
  ).stdout.trim()
}

const FETCH_TIMEOUT_MS = 120_000

/** host/owner/repo for https, ssh:// and scp-style remotes, so two clones of one repo match. */
export function remoteIdentity(url: string): string | null {
  const trimmed = url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  // A clone of a repository on this computer's disk matches only the same path.
  if (isAbsolute(trimmed)) {
    return `file:${trimmed}`
  }
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(trimmed)
  if (scp) {
    return `${scp[1]!.toLowerCase()}/${scp[2]}`
  }
  try {
    const parsed = new URL(trimmed)
    return parsed.hostname ? `${parsed.hostname.toLowerCase()}${parsed.pathname}` : null
  } catch {
    return null
  }
}

export type ClaimerWorkspace =
  /** `workspaceId` null: a folder workspace is created in `projectGroupId` before the launch. */
  | { kind: 'folder'; path: string; workspaceId: string | null; projectGroupId: string | null }
  | { kind: 'git'; repo: Pick<Repo, 'id' | 'path'>; branch: string; commit: string }

export type ClaimerCatalog = {
  repos: readonly Repo[]
  folders: readonly Pick<FolderWorkspace, 'id' | 'folderPath' | 'connectionId'>[]
  groups: readonly Pick<ProjectGroup, 'id' | 'parentPath' | 'connectionId'>[]
}

const inside = (parent: string, path: string): boolean => {
  const rel = relative(parent, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Where it can run here, or why not (without changing anything). */
export async function findClaimerWorkspace(
  required: WakeCopyWorkspace,
  catalog: ClaimerCatalog,
  home = homedir()
): Promise<ClaimerWorkspace | { refusal: string }> {
  if (required.kind === 'folder') {
    const rel = required.workRelativePath
    // Why: the path comes from another computer; it never leaves this computer's ~/Work.
    if (rel !== '' && !isRelocationManifestPath(rel)) {
      return { refusal: 'its folder is not inside ~/Work' }
    }
    const work = await realpath(join(home, 'Work')).catch(() => null)
    const named = join(home, 'Work', ...rel.split('/').filter(Boolean))
    const info = await stat(named).catch(() => null)
    const path = info?.isDirectory() ? await realpath(named).catch(() => null) : null
    if (!work || !path || !inside(work, path)) {
      return { refusal: `~/Work/${rel} is not on this computer` }
    }
    const local = async (candidate: string | null | undefined) =>
      candidate ? await realpath(candidate).catch(() => null) : null
    for (const folder of catalog.folders) {
      if (!folder.connectionId && (await local(folder.folderPath)) === path) {
        // Why its registered spelling: the launch selector matches that path exactly.
        return {
          kind: 'folder',
          path: folder.folderPath,
          workspaceId: folder.id,
          projectGroupId: null
        }
      }
    }
    // Why a project above it: Claude finds a transcript by its exact folder, so it runs there.
    for (const group of catalog.groups) {
      const parent = group.connectionId ? null : await local(group.parentPath)
      if (parent && inside(parent, path)) {
        return { kind: 'folder', path, workspaceId: null, projectGroupId: group.id }
      }
    }
    return { refusal: `no OmniConsole project here holds ~/Work/${required.workRelativePath}` }
  }
  const repos = catalog.repos
  const wanted = remoteIdentity(required.remoteUrl)
  let lastRefusal: string | null = null
  for (const repo of repos) {
    // Why not WSL: its git, provider and accounts are another system's; this check reads Windows'.
    if (repo.connectionId || isFolderRepo(repo) || isWslUncPath(repo.path)) {
      continue
    }
    const origin = await git(repo.path, ['remote', 'get-url', 'origin']).catch(() => '')
    if (!wanted || remoteIdentity(origin) !== wanted) {
      continue
    }
    const listed = await git(
      repo.path,
      ['ls-remote', '--heads', 'origin', `refs/heads/${required.branch}`],
      { timeout: WAKE_COPY_GIT_NETWORK_TIMEOUT_MS }
    ).catch(() => '')
    // Why exactly the commit it slept on: a newer push is someone else's work.
    if (listedHead(listed, required.branch) !== required.commit) {
      lastRefusal = `origin/${required.branch} is no longer at the commit it slept on`
      continue
    }
    const local = await localBranchRefusal(repo.path, required.branch, required.commit)
    if (local) {
      lastRefusal = local
      continue
    }
    return { kind: 'git', repo, branch: required.branch, commit: required.commit }
  }
  return {
    refusal: lastRefusal ?? 'this computer has no clone of its repository in OmniConsole'
  }
}

/** Why the local branch cannot take the session (checked out here, or ahead of it), or null. */
async function localBranchRefusal(
  repoPath: string,
  branch: string,
  commit: string
): Promise<string | null> {
  const worktrees = await git(repoPath, ['worktree', 'list', '--porcelain'])
  // Why: a branch checked out here already would make the create pick another branch name.
  if (worktrees.split('\n').includes(`branch refs/heads/${branch}`)) {
    return `${branch} is already checked out in a worktree here`
  }
  const local = await git(repoPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`
  ]).catch(() => '')
  const known = await git(repoPath, ['cat-file', '-e', `${commit}^{commit}`]).then(
    () => true,
    () => false
  )
  if (!local || local === commit || !known) {
    return null
  }
  const behind = await git(repoPath, ['merge-base', '--is-ancestor', local, commit]).then(
    () => true,
    () => false
  )
  return behind ? null : `the local branch ${branch} here has commits the session does not`
}

/**
 * A local branch of that name at the commit (created when missing, fast-forwarded when behind;
 * one with other commits is refused), for the runtime's create to check out as an existing branch.
 */
export async function prepareClaimerBranch(
  workspace: Extract<ClaimerWorkspace, { kind: 'git' }>
): Promise<void> {
  const { repo, branch, commit } = workspace
  const refusal = await localBranchRefusal(repo.path, branch, commit)
  if (refusal) {
    throw new Error(refusal)
  }
  await git(
    repo.path,
    [
      ...GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS,
      'fetch',
      '--quiet',
      'origin',
      `refs/heads/${branch}`
    ],
    { timeout: FETCH_TIMEOUT_MS }
  )
  const local = await git(repo.path, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`
  ]).catch(() => '')
  if (!local) {
    await git(repo.path, ['branch', branch, commit])
    return
  }
  if (local === commit) {
    return
  }
  const behind = await git(repo.path, ['merge-base', '--is-ancestor', local, commit]).then(
    () => true,
    () => false
  )
  if (!behind) {
    throw new Error(`the local branch ${branch} here has commits the session does not`)
  }
  // Fast-forward only; git refuses while another worktree has it checked out.
  await git(repo.path, ['branch', '--force', branch, commit])
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Files the session wrote, restored only where missing or unchanged: a file that differs here is
 * newer work and stays as it is. Returns the paths kept as they were.
 */
export async function restoreWrittenFiles(
  header: Pick<WakeCopyHeader, 'written'> & Partial<Pick<WakeCopyHeader, 'workspace'>>,
  writtenRoot: string,
  folder: string
): Promise<string[]> {
  const kept: string[] = []
  for (const file of header.written) {
    const target = join(folder, ...file.path.split('/'))
    const present = await lstat(target).catch(() => null)
    if (present) {
      const same = present.isFile() && sha256(await readFile(target)) === file.sha256
      if (same) {
        continue
      }
      const cleanAtCommit =
        header.workspace?.kind === 'git' &&
        present.isFile() &&
        (await git(folder, ['status', '--porcelain', '--', file.path]).catch(() => 'dirty')) === ''
      if (!cleanAtCommit) {
        kept.push(file.path)
        continue
      }
      await writeFile(target, await readFile(join(writtenRoot, ...file.path.split('/'))))
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await readFile(join(writtenRoot, ...file.path.split('/'))), {
      flag: 'wx'
    })
  }
  return kept
}
