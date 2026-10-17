import { createHash } from 'node:crypto'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  relativeInside,
  routeHandoffFiles,
  type HandoffRouteFile,
  type HandoffRoutePlan
} from '../../shared/handoff-file-routing'
import {
  HANDOFF_MANIFEST_NAME,
  buildHandoffManifest,
  handoffMemoLines,
  serializeHandoffManifest,
  type HandoffManifestFile
} from '../../shared/handoff-manifest'
import {
  handoffRoutePreparationRequest,
  type HandoffRoutePreparation,
  type HandoffRoutePreparationRequest
} from '../../shared/handoff-route-preparation'
import type { GitRuntimeOptions } from '../git/git-runtime-options'
import { checkIgnoredPaths } from '../git/check-ignored-paths'
import { handoffGitRead } from './handoff-git-exec'
import { commitHandoffFilesToBranch } from './handoff-git-route'
import { HandoffGitFilterMismatchError } from './handoff-git-file-verification'
import { failure, validated } from './console-workflow-transport'

/**
 * Decide how each of a handoff's files travels, make it happen, and write the index that lets the
 * receiving machine put everything back.
 *
 * Only the main process can answer the questions the rule asks — is this path inside the
 * repository, does git ignore it — and only it can make the commit. The renderer hands over the
 * captured pins and gets back the ones that still need uploading.
 */
async function repoRootFor(
  workspacePath: string,
  options: GitRuntimeOptions
): Promise<string | null> {
  const root = await handoffGitRead(['rev-parse', '--show-toplevel'], workspacePath, options)
  return root ? await realpath(root).catch(() => root) : null
}

/** Which of `relPaths` git ignores. `check-ignore` exits 1 when it matches nothing, which is not an error. */
async function ignoredPaths(
  repoRoot: string,
  relPaths: readonly string[],
  options: GitRuntimeOptions
): Promise<Set<string>> {
  if (relPaths.length === 0) {
    return new Set()
  }
  try {
    return new Set(await checkIgnoredPaths(repoRoot, [...relPaths], { ...options, noIndex: true }))
  } catch {
    // An unanswered ignore check cannot authorize publishing the selected bytes.
    return new Set(relPaths)
  }
}

/**
 * Both sides of the comparison are resolved before it happens.
 *
 * `git rev-parse --show-toplevel` answers with the real path, while a workspace path can reach the
 * same directory through a symlink — every macOS temp directory does. Comparing the two as strings
 * then says a repository file is outside its own repository, and it silently travels as bytes.
 */
async function resolvePath(path: string): Promise<string> {
  return realpath(path).catch(() => path)
}

async function describeFiles(
  paths: readonly string[],
  repoRoot: string | null,
  options: GitRuntimeOptions
): Promise<{ files: HandoffRouteFile[]; originalOf: Map<string, string> }> {
  const originalOf = new Map<string, string>()
  const resolved: string[] = []
  for (const path of paths) {
    const real = await resolvePath(path)
    originalOf.set(real, path)
    resolved.push(real)
  }
  const relByPath = new Map<string, string>()
  for (const path of resolved) {
    const rel = repoRoot ? relativeInside(repoRoot, path) : null
    if (rel) {
      relByPath.set(path, rel)
    }
  }
  const ignored = repoRoot
    ? await ignoredPaths(repoRoot, [...relByPath.values()], options)
    : new Set<string>()
  const files = await Promise.all(
    resolved.map(async (path) => {
      const rel = relByPath.get(path)
      const size = await stat(path)
        .then((info) => info.size)
        .catch(() => null)
      return {
        path,
        size: size ?? 0,
        repoRoot,
        ignored: rel ? ignored.has(rel) : false,
        readable: size !== null
      }
    })
  )
  return { files, originalOf }
}

function manifestEntriesFor(
  plan: HandoffRoutePlan,
  pins: HandoffRoutePreparationRequest['pins'],
  workspacePath: string,
  repoRoot: string | null,
  originalOf: Map<string, string>
): HandoffManifestFile[] {
  const byPath = new Map(pins.filter((pin) => pin.sourcePath).map((pin) => [pin.sourcePath!, pin]))
  const pinFor = (path: string) => byPath.get(originalOf.get(path) ?? path)
  const entries: HandoffManifestFile[] = []
  for (const route of plan.git) {
    const pin = pinFor(route.path)
    if (pin) {
      entries.push({
        rel: route.rel,
        name: pin.name,
        route: 'git',
        sha256: pin.sha256,
        size: pin.size
      })
    }
  }
  for (const [route, kind] of [
    [plan.pin, 'pin' as const],
    [plan.card, 'card' as const]
  ] as const) {
    for (const entry of route) {
      const pin = pinFor(entry.path)
      if (!pin) {
        continue
      }
      // A file outside the repository keeps its name; one inside keeps the folder it sat in, so a
      // checkout and a materialize put it back in the same place.
      const rel =
        (repoRoot && relativeInside(repoRoot, entry.path)) ||
        relativeInside(workspacePath, entry.path)
      entries.push({
        rel: rel ?? pin.name,
        name: pin.name,
        route: kind,
        sha256: pin.sha256,
        size: pin.size
      })
    }
  }
  for (const pin of pins) {
    if (pin.sourcePath === null) {
      // The generated session summary has no file on disk; it travels as bytes under its own name.
      entries.push({
        rel: pin.name,
        name: pin.name,
        route: 'pin',
        sha256: pin.sha256,
        size: pin.size
      })
    }
  }
  return entries
}

export async function prepareHandoffFileRoutes(
  request: HandoffRoutePreparationRequest,
  options: GitRuntimeOptions = {}
): Promise<HandoffRoutePreparation> {
  const { workspacePath, pins, branch, label } = request
  const paths = pins.map((pin) => pin.sourcePath).filter((path): path is string => path !== null)
  const repoRoot = await repoRootFor(workspacePath, options)
  if (request.includeWorkingTree && !repoRoot) {
    return { git: null, pins, memoLines: [], refused: [], manifest: [] }
  }
  const { files: described, originalOf } = await describeFiles(paths, repoRoot, options)
  const plan = routeHandoffFiles(described, {
    kind: request.next,
    sameWorktree: request.sameWorktree
  })
  const refused = plan.refused.map((entry) => ({
    name: entry.path.split(/[\\/]/).at(-1) ?? entry.path,
    reason: entry.reason
  }))
  if (refused.length > 0 || plan.none) {
    return { git: null, pins: plan.none ? [] : pins, memoLines: [], refused, manifest: [] }
  }
  let git: HandoffRoutePreparation['git'] = null
  // Handing over a live session commits the whole working tree: `.` is git's own way of saying
  // "everything here that is not ignored", which is exactly the work in progress.
  const commit = async () => {
    const relPaths = request.includeWorkingTree ? ['.'] : plan.git.map((entry) => entry.rel)
    return relPaths.length === 0
      ? null
      : commitHandoffFilesToBranch({
          worktreePath: repoRoot ?? workspacePath,
          branch,
          relPaths,
          message: `handoff: ${label}`.slice(0, 500),
          options,
          expectations: manifestEntriesFor(plan, pins, workspacePath, repoRoot, originalOf).filter(
            (entry) => entry.route === 'git'
          )
        })
  }
  try {
    try {
      git = await commit()
    } catch (error) {
      if (!(error instanceof HandoffGitFilterMismatchError)) {
        throw error
      }
      const filtered = new Set(error.paths)
      for (const entry of plan.git.filter((entry) => filtered.has(entry.rel))) {
        plan.pin.push({ route: 'pin', path: entry.path, name: entry.rel.split('/').at(-1)! })
      }
      plan.git = plan.git.filter((entry) => !filtered.has(entry.rel))
      git = await commit()
    }
  } catch (error) {
    return {
      git: null,
      pins,
      memoLines: [],
      refused: [{ name: branch, reason: error instanceof Error ? error.message : String(error) }],
      manifest: []
    }
  }
  const manifestEntries = manifestEntriesFor(
    plan,
    pins,
    await resolvePath(workspacePath),
    repoRoot,
    originalOf
  )
  const manifest = buildHandoffManifest({
    createdAt: new Date(),
    source: { sessionLabel: label, workspacePath },
    ...(git
      ? {
          git: {
            repo: git.repo,
            branch: git.branch,
            sha: git.sha,
            ...(git.baseBranch ? { baseBranch: git.baseBranch } : {})
          }
        }
      : {}),
    ...(request.trail ? { trail: request.trail } : {}),
    memo: request.memo,
    files: manifestEntries
  })
  const manifestPath = join(
    workspacePath,
    '.omni',
    'handoffs',
    branch.replace(/[\\/]/g, '-'),
    HANDOFF_MANIFEST_NAME
  )
  const text = serializeHandoffManifest(manifest)
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, text, 'utf8')
  const bytes = Buffer.from(text, 'utf8')
  const gitPaths = new Set(plan.git.map((entry) => originalOf.get(entry.path) ?? entry.path))
  return {
    git,
    // Files the commit carries no longer travel as bytes; the manifest joins the ones that do.
    pins: [
      ...pins.filter((pin) => pin.sourcePath === null || !gitPaths.has(pin.sourcePath)),
      {
        sourcePath: manifestPath,
        name: HANDOFF_MANIFEST_NAME,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.byteLength
      }
    ],
    memoLines: handoffMemoLines(manifest),
    refused: [],
    manifest: manifestEntries
  }
}

/** The IPC entry point; validates the request the same way every other console verb does. */
export const prepareHandoffRoutes = (args: unknown) =>
  validated<HandoffRoutePreparationRequest, HandoffRoutePreparation>(
    args,
    handoffRoutePreparationRequest,
    async (request) => {
      try {
        return { ok: true as const, data: await prepareHandoffFileRoutes(request) }
      } catch (error) {
        return failure(
          'file_unavailable',
          error instanceof Error
            ? error.message
            : 'The files could not be prepared for this handoff.'
        )
      }
    }
  )
