import { realpathSync } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'

// Credentials, shell startup files (they export tokens) and provider account homes. A read-only
// agent never needs them, even when the workspace is the home folder itself.
export const WORKFLOW_CREDENTIAL_NAMES = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.config',
  '.docker',
  '.kube',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.gitconfig',
  '.env',
  '.zshenv',
  '.zshrc',
  '.zprofile',
  '.zlogin',
  '.bashrc',
  '.bash_profile',
  '.profile',
  join('Library', 'Keychains')
]
export const WORKFLOW_PROVIDER_HOME_PREFIXES = ['.claude', '.codex', '.gemini', '.grok']
// Data outside the home folder that Codex's read-only base would still expose: other people's
// homes, mounted volumes and temporary files (other agents' tool output). Resolved paths, because
// the sandbox compares resolved paths.
const OUTSIDE_DATA_ROOTS =
  process.platform === 'darwin'
    ? ['/Users', '/Volumes', '/private/tmp', '/private/var/folders', '/private/var/tmp']
    : ['/home', '/root', '/tmp', '/var/tmp', '/mnt', '/media', '/run/user']

/** True when `path` is `folder` itself or inside it. */
export function workflowPathWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`)
}

/** The canonical home folder (sandboxes compare resolved paths). */
export function workflowHomeFolder(): string {
  const home = homedir()
  try {
    return realpathSync(home)
  } catch {
    return home
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** Credential locations that exist in `home` right now. */
export async function workflowCredentialPaths(home: string): Promise<string[]> {
  const names = await readdir(home).catch(() => [] as string[])
  const candidates = [
    ...WORKFLOW_CREDENTIAL_NAMES.map((name) => join(home, name)),
    ...names
      .filter((name) => WORKFLOW_PROVIDER_HOME_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .map((name) => join(home, name))
  ]
  const present = await Promise.all(candidates.map(exists))
  return [...new Set(candidates.filter((_, index) => present[index]))]
}

/**
 * Whether the home folder can be reached inside `root`: `root` is the home folder or one of its
 * ancestors under any spelling (letter case, a link), or holds it under its own path, as the data
 * volume /System/Volumes/Data holds /Users. Folders are compared by identity, not by path.
 */
export async function workflowRootContainsHome(
  root: string,
  home = workflowHomeFolder()
): Promise<boolean> {
  if (workflowPathWithin(home, root)) {
    return true
  }
  const identity = (path: string) => stat(path, { bigint: true }).catch(() => undefined)
  const own = await identity(home)
  if (!own) {
    return false
  }
  for (let folder = home; ; folder = dirname(folder)) {
    const entry = await identity(join(root, relative(folder, home)))
    if (entry?.dev === own.dev && entry.ino === own.ino) {
      return true
    }
    if (dirname(folder) === folder) {
      return false
    }
  }
}

/**
 * Agents never read a workspace that holds the home folder. Logins and keys live all over it
 * (keychains, app data, provider accounts), no deny list can name them all, and Claude and Gemini
 * have no kernel sandbox to enforce one.
 */
export async function assertWorkflowReadableRoot(
  root: string,
  home = workflowHomeFolder()
): Promise<void> {
  if (await workflowRootContainsHome(root, home)) {
    throw new Error(
      `Agents can't read ${root}: it contains your home folder, where logins and keys live. Open a project folder, choose specific files and folders instead, or choose Knowledge only.`
    )
  }
}

/**
 * What a Codex workspace-read agent must not read: the home folder as a whole and the other data
 * outside it. The workspace stays readable as the more specific rule, and a data root that lies
 * inside the workspace is not hidden from it.
 */
export async function workflowCodexHiddenPaths(
  root: string,
  home = workflowHomeFolder()
): Promise<string[]> {
  const outside = OUTSIDE_DATA_ROOTS.filter(
    (path) => path !== home && !workflowPathWithin(path, root)
  )
  const present = await Promise.all(outside.map(exists))
  return [home, ...outside.filter((_, index) => present[index])]
}

// What Grok itself reads from the account home while it runs: the linked login and policy files.
const GROK_ACCOUNT_KEEP = new Set([
  'auth.json',
  'auth.json.lock',
  'bin',
  'managed_config.toml',
  'requirements.toml'
])

/**
 * Kernel-denied paths for a streamed Grok run. Its sandbox grants the account home (the login is
 * linked from there), so everything else in that home is denied: other sessions, notes and the
 * account config with its MCP settings. Nothing that contains a path Grok needs is ever denied.
 */
export async function workflowGrokDeniedPaths(input: {
  account: string
  needed: readonly string[]
  root?: string
  home?: string
}): Promise<string[]> {
  const entries = await readdir(input.account).catch(() => [] as string[])
  const home = input.home ?? workflowHomeFolder()
  const credentials =
    input.root && workflowPathWithin(home, input.root) ? await workflowCredentialPaths(home) : []
  const needed = [input.account, ...input.needed, ...(input.root ? [input.root] : [])]
  return [
    ...entries
      .filter((name) => !GROK_ACCOUNT_KEEP.has(name))
      .map((name) => join(input.account, name)),
    ...credentials
  ].filter((path) => !needed.some((kept) => workflowPathWithin(kept, path)))
}
