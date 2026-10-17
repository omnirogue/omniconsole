import { consoleConversationSourcePath } from '../../shared/console-conversation-source-files'

export type FleetSourceGit = (args: string[]) => Promise<string>
export type FleetSourceGitState = {
  baseCommit?: string
  remoteUrl?: string
  branch?: string
  status: string
  changes: string[]
  deletions: string[]
  submodules: string[]
}

function dirtyStatusPaths(status: string): string[] {
  const records = status.split('\0').filter(Boolean)
  const paths: string[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error('The source host returned an invalid Git status record.')
    }
    paths.push(validateFleetSourcePath(record.slice(3)))
    if (/[RC]/.test(record.slice(0, 2))) {
      const original = records[++index]
      if (!original) {
        throw new Error('The source host returned an incomplete Git rename record.')
      }
      paths.push(validateFleetSourcePath(original))
    }
  }
  return paths
}

export function validateFleetSourcePath(path: string): string {
  if (!consoleConversationSourcePath.safeParse(path).success || path.includes('\ufffd')) {
    throw new Error(`This source path cannot be dispatched safely: ${JSON.stringify(path)}`)
  }
  if (path.split('/').some((part) => part.toLowerCase() === '.git')) {
    throw new Error('Git administrative files cannot be included in a fleet source snapshot.')
  }
  return path
}

export function isImplicitFleetSecret(path: string): boolean {
  return path
    .split('/')
    .some(
      (part) =>
        /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.azure|\.kube|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|connections\.env)$/i.test(
          part
        ) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(part)
    )
}

export async function readFleetSourceGitState(
  git: FleetSourceGit,
  includeUntracked = false
): Promise<FleetSourceGitState> {
  let prefix: string
  try {
    prefix = (await git(['rev-parse', '--show-prefix'])).trim()
  } catch (error) {
    if (error instanceof Error && /not a git repository/i.test(error.message)) {
      return { status: '', changes: [], deletions: [], submodules: [] }
    }
    throw error
  }
  if (prefix !== '') {
    return { status: '', changes: [], deletions: [], submodules: [] }
  }
  let baseCommit: string
  try {
    baseCommit = (await git(['rev-parse', '--verify', 'HEAD'])).trim()
  } catch {
    throw new Error('Commit this repository before dispatching its source snapshot.')
  }
  if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) {
    throw new Error('The source host did not return an exact Git HEAD.')
  }
  const status = await git([
    'status',
    '--porcelain=v1',
    '-z',
    includeUntracked ? '--untracked-files=all' : '--untracked-files=no',
    '--ignore-submodules=none'
  ])
  const names = await git([
    'diff',
    '--no-ext-diff',
    '--no-renames',
    '--ignore-submodules=none',
    '--name-only',
    '-z',
    'HEAD',
    '--'
  ])
  const deletedNames = await git([
    'diff',
    '--no-ext-diff',
    '--no-renames',
    '--diff-filter=D',
    '--name-only',
    '-z',
    'HEAD',
    '--'
  ])
  const entries = await git(['ls-files', '--stage', '-z'])
  const baseEntries = await git(['ls-tree', '-r', '-z', 'HEAD'])
  let remoteUrl: string | undefined
  try {
    remoteUrl = (await git(['remote', 'get-url', 'origin'])).trim() || undefined
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/no such remote|does not appear to be a git repository/i.test(error.message)
    ) {
      throw error
    }
  }
  const branchName = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const submodules: string[] = []
  for (const entry of entries.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(entry)
    if (!match) {
      throw new Error('The source host returned an invalid Git index record.')
    }
    if (match[2] !== '0') {
      throw new Error('Resolve merge conflicts before dispatching a source snapshot.')
    }
    if (match[1] === '160000') {
      submodules.push(validateFleetSourcePath(match[3]))
    }
  }
  for (const entry of baseEntries.split('\0').filter(Boolean)) {
    const match = /^160000 commit [a-f0-9]+\t([\s\S]+)$/.exec(entry)
    if (match) {
      submodules.push(validateFleetSourcePath(match[1]))
    }
  }
  return {
    baseCommit,
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(branchName !== 'HEAD' ? { branch: branchName } : {}),
    status,
    changes: [
      ...new Set([
        ...names.split('\0').filter(Boolean).map(validateFleetSourcePath),
        ...dirtyStatusPaths(status)
      ])
    ],
    deletions: deletedNames.split('\0').filter(Boolean).map(validateFleetSourcePath),
    submodules: [...new Set(submodules)]
  }
}

export function assertFleetSourceGitUnchanged(
  before: FleetSourceGitState,
  after: FleetSourceGitState
): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      'The workspace changed while capturing its source. Wait for edits to finish and try again.'
    )
  }
}
