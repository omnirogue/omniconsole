import { SESSION_CHAIN_OUTPUT_ROOT } from '../../shared/session-chain-types'
import type { SessionChain } from '../../shared/session-chain-types'
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import type { SessionOutcome } from '../../shared/session-outcome-types'

const contentIdentities = new Map<string, { signature: string; oid: string }>()

export function sessionOutcomeCandidatePaths(
  outcome?: SessionOutcome,
  chain?: SessionChain
): string[] {
  return [
    ...new Set([
      ...(outcome?.conditions.flatMap((condition) => [
        ...(condition.kind === 'file' ? [condition.target] : []),
        ...(condition.fileVersions?.map((file) => file.path) ?? [])
      ]) ?? []),
      ...(chain?.outcomeSet?.continuation.sourcePacket?.files.map((file) => file.sourcePath) ?? [])
    ])
  ]
}

/** Git object identities cover unchanged files without reading their worktree contents. */
export async function sessionOutcomeCandidateVersion(
  workspacePath: string,
  deliverables: string[] = [],
  options: { folderPin?: boolean } = {}
): Promise<string> {
  const digest = createHash('sha256')
  let paths = deliverables
  const objects = new Map<string, string>()
  let objectAlgorithm = 'sha1'
  const declaredPaths = new Set(deliverables.map((path) => resolve(workspacePath, path)))
  // All options predate Git 2.25. Only a non-repository probe permits explicit folder scope.
  const git = async (args: string[], probe = false) => {
    const result = await runProcess({
      program: 'git',
      args: ['-C', workspacePath, ...args],
      env: { ...process.env, LC_ALL: 'C' },
      timeoutMs: 15_000,
      maxOutputBytes: 16 * 1024 * 1024
    })
    if (
      probe &&
      result.code === 128 &&
      !result.timedOut &&
      /^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point [^\n]+)\)/.test(
        result.stderr
      )
    ) {
      return null
    }
    if (
      result.code !== 0 ||
      result.timedOut ||
      Buffer.byteLength(result.stdout) >= 16 * 1024 * 1024
    ) {
      throw new Error(
        'Cannot identify the review candidate with Git. Restore Git access before reviewing.'
      )
    }
    return result.stdout
  }
  const repository = await git(['rev-parse', '--is-inside-work-tree'], true)
  if (repository?.trim() === 'true') {
    const [index, changed, untracked] = await Promise.all([
      git(['ls-files', '--stage', '-z']),
      git(['diff-files', '--name-only', '-z', '--no-ext-diff']),
      git(['ls-files', '--others', '--exclude-standard', '-z'])
    ])
    for (const entry of index!.split('\0').filter(Boolean)) {
      const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry)
      if (!match || match[3] !== '0') {
        throw new Error('Resolve the Git index conflict before reviewing the candidate.')
      }
      objectAlgorithm = match[2].length === 64 ? 'sha256' : 'sha1'
      objects.set(resolve(workspacePath, match[4]), `${match[1]} ${match[2]}`)
    }
    // Reports are runtime output, unless tracked or explicitly part of the requested delivery.
    const userUntracked = untracked!
      .split('\0')
      .filter((path) => !path.startsWith(`${SESSION_CHAIN_OUTPUT_ROOT}/`))
    paths = [...deliverables, ...changed!.split('\0'), ...userUntracked].filter(Boolean)
  }
  if (repository !== null && repository.trim() !== 'true') {
    throw new Error('Review requires a Git working tree, not a bare repository.')
  }
  if (repository === null && !deliverables.length) {
    if (!options.folderPin) {
      throw new Error('Select explicit deliverable files for a folder workspace before reviewing.')
    }
    // Verify gates only: much contract work leaves nothing here (a reply sent, an ad changed). The
    // pin is the folder itself — no content claim — and the verdict stays bound to its own attempt,
    // judging what its seat observes wherever the work landed. Reviews keep needing named files.
    return createHash('sha256')
      .update(JSON.stringify(['folder-without-named-files', resolve(workspacePath)]))
      .digest('hex')
  }
  for (const path of [...new Set(paths.map((entry) => resolve(workspacePath, entry)))].sort()) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    })
    if (!info) {
      objects.set(path, 'deleted')
      continue
    }
    if (!info.isFile() && !info.isSymbolicLink()) {
      throw new Error(`Review deliverable must name a file: ${path}`)
    }
    if (info.size > 64 * 1024 * 1024) {
      throw new Error(`Review deliverable exceeds the per-file content limit: ${path}`)
    }
    const declared = declaredPaths.has(path)
    const targetInfo = declared && info.isSymbolicLink() ? await stat(path) : info
    const signature = [
      objectAlgorithm,
      info.ctimeMs,
      info.mtimeMs,
      targetInfo.ctimeMs,
      targetInfo.mtimeMs,
      targetInfo.size,
      targetInfo.ino
    ].join(':')
    const cacheKey = `${declared ? 'file' : 'git'}:${path}`
    const cached = contentIdentities.get(cacheKey)
    let oid = cached?.signature === signature ? cached.oid : undefined
    if (!oid) {
      if (!targetInfo.isFile() && declared) {
        throw new Error(`Review deliverable must name a file: ${path}`)
      }
      if (targetInfo.size > 64 * 1024 * 1024) {
        throw new Error(`Review deliverable exceeds the per-file content limit: ${path}`)
      }
      const content =
        info.isSymbolicLink() && !declared
          ? Buffer.from(await readlink(path))
          : await readFile(path)
      oid = createHash(objectAlgorithm)
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest('hex')
      if (contentIdentities.size >= 10000) {
        contentIdentities.clear()
      }
      contentIdentities.set(cacheKey, { signature, oid })
    }
    const mode = info.isSymbolicLink() ? '120000' : info.mode & 0o111 ? '100755' : '100644'
    objects.set(
      path,
      `${mode} ${oid}${declared && info.isSymbolicLink() ? ` link:${await readlink(path)}` : ''}`
    )
  }
  for (const [path, identity] of [...objects].sort(([a], [b]) => a.localeCompare(b))) {
    digest.update(path).update('\0').update(identity).update('\0')
  }
  return digest.digest('hex')
}

/**
 * The workspace files a step changed beside what it declared, sorted.
 *
 * A Plan Mode step promises to write its plan and nothing else (arch v5 §5). The baseline is the
 * worktree's own Git state, which is the only "before" this build persists anywhere; two sets are
 * excluded from it: `.omni/runs/**`, which is where every step's reports live (F8), and the paths
 * the outcome DECLARED, so a sibling step's declared deliverable never trips its neighbour's check.
 *
 * Observation failures throw. A plan step whose workspace cannot be observed is unproven, never
 * `unchanged` (arch v5 §17 Tier 1 item 8) — the caller turns the throw into a blocked outcome.
 */
export async function sessionOutcomeWorkspaceChanges(
  workspacePath: string,
  declared: string[] = []
): Promise<string[]> {
  const observe = async (args: string[]) => {
    const result = await runProcess({
      program: 'git',
      args: ['-C', workspacePath, ...args],
      env: { ...process.env, LC_ALL: 'C' },
      timeoutMs: 15_000,
      maxOutputBytes: 16 * 1024 * 1024
    })
    if (
      result.code !== 0 ||
      result.timedOut ||
      Buffer.byteLength(result.stdout) >= 16 * 1024 * 1024
    ) {
      throw new Error(
        'Cannot observe the workspace with Git. Restore Git access before verifying a plan.'
      )
    }
    return result.stdout
  }
  // Porcelain paths are repository-root-relative even when the workspace is a subdirectory, so the
  // root is what they must be resolved against — otherwise `.omni/runs` reads as an ordinary edit.
  // The prefix comes from Git too: a workspace reached through a symlink (every macOS temp path is)
  // does not spell its own location the way Git spells it, and two spellings compare as two files.
  const [root, prefix = ''] = (await observe(['rev-parse', '--show-toplevel', '--show-prefix']))
    .split('\n')
    .map((line) => line.trim())
  if (!root) {
    throw new Error('Cannot observe the workspace with Git: it is not a working tree.')
  }
  const base = resolve(root, prefix)
  const excluded = new Set(declared.map((path) => resolve(base, path)))
  // --no-renames keeps every entry a single path; -z keeps a path with a space or a quote intact.
  const status = await observe([
    'status',
    '--porcelain=v1',
    '-z',
    '--no-renames',
    '--untracked-files=all'
  ])
  const runs = resolve(base, SESSION_CHAIN_OUTPUT_ROOT)
  const changed = new Set<string>()
  for (const entry of status.split('\0').filter(Boolean)) {
    // `XY path`: two status columns and one separator, then the path exactly as Git spells it.
    const path = entry.slice(3)
    if (!path) {
      continue
    }
    const absolute = resolve(root, path)
    if (absolute === runs || absolute.startsWith(`${runs}${sep}`) || excluded.has(absolute)) {
      continue
    }
    changed.add(path)
  }
  return [...changed].sort()
}
