import { createHash, randomUUID } from 'node:crypto'
import { HANDOFF_FILE_MAX_BYTES } from '../../shared/console-handoff-contract'
import { conversationFleetPortableHandoffDeliverables } from '../../shared/conversation-fleet-handoff-paths'
import {
  FLEET_SOURCE_MAX_BYTES,
  FLEET_SOURCE_MAX_DELETIONS,
  FLEET_SOURCE_MAX_FILES,
  type CaptureFleetSourceRequest,
  type CaptureFleetSourceResult
} from '../../shared/conversation-fleet-source-snapshot'
import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/cross-platform-path'
import { gitExecFileAsync } from '../git/runner'
import { isENOENT } from '../ipc/filesystem-path-containment'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  assertFleetSourcePath,
  createFleetSourceIo,
  type SourceStat
} from './conversation-fleet-source-io'
import {
  assertFleetSourceGitUnchanged,
  isImplicitFleetSecret,
  readFleetSourceGitState,
  validateFleetSourcePath
} from './conversation-fleet-source-git'
import { captureFleetSourceDeliverables } from './conversation-fleet-source-deliverables'

export type FleetSourceTarget = {
  rootPath: string
  connectionId?: string
  localGitOptions?: { wslDistro?: string }
}

export type CapturedFleetSource = {
  manifest: CaptureFleetSourceResult
  bytes: Map<string, Buffer>
}

function selectedRelativePath(root: string, canonicalRoot: string, input: string): string {
  const relative = isRuntimePathAbsolute(input)
    ? (relativePathInsideRoot(root, input) ?? relativePathInsideRoot(canonicalRoot, input))
    : input
  if (relative === null) {
    throw new Error('Choose source files inside this conversation’s workspace.')
  }
  return validateFleetSourcePath(relative)
}

function assertSameSourceStat(before: SourceStat, after: SourceStat): void {
  if (
    before.type !== after.type ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.mode !== after.mode
  ) {
    throw new Error(
      'A source file changed while capturing the workspace. Try again after edits finish.'
    )
  }
}

export async function captureConversationFleetSource(
  target: FleetSourceTarget,
  request: CaptureFleetSourceRequest,
  signal?: AbortSignal
): Promise<CapturedFleetSource> {
  if (
    request.expectedConnectionId !== undefined &&
    request.expectedConnectionId !== (target.connectionId ?? null)
  ) {
    throw new Error('The workspace execution host changed. Reopen dispatch and try again.')
  }
  signal?.throwIfAborted()
  const io = createFleetSourceIo(target.connectionId)
  const root = await io.realpath(target.rootPath)
  const rootBefore = await io.lstat(root)
  if (rootBefore.type !== 'directory') {
    throw new Error('The source workspace is not a directory.')
  }
  const sshGit = target.connectionId ? requireSshGitProvider(target.connectionId) : undefined
  const git = async (args: string[]): Promise<string> => {
    signal?.throwIfAborted()
    const result = sshGit
      ? await sshGit.exec(args, root, { signal, timeoutMs: 30_000 })
      : await gitExecFileAsync(args, {
          cwd: root,
          ...target.localGitOptions,
          signal,
          timeout: 30_000
        })
    return result.stdout
  }
  const before = await readFleetSourceGitState(git, request.includeUntracked)
  const deliverables = await captureFleetSourceDeliverables({
    io,
    root,
    sourceWorkspacePath: target.rootPath,
    deliverables: request.deliverables
      ? conversationFleetPortableHandoffDeliverables(request.deliverables, target.rootPath)
      : undefined,
    relativePath: (path) => selectedRelativePath(target.rootPath, root, path),
    signal
  })
  const rule = deliverables.deliverables
  const explicitDeliverables =
    rule?.kind === 'files'
      ? rule.paths
      : rule?.kind === 'manifest'
        ? [rule.manifestPath]
        : (rule?.manifestPaths ?? [])
  const selected = new Set([
    ...request.paths.map((path) => selectedRelativePath(target.rootPath, root, path)),
    ...explicitDeliverables
  ])
  const paths = new Set([
    ...selected,
    ...deliverables.paths,
    ...(request.includeDirtyTracked ? before.changes : [])
  ])
  if (
    before.deletions.some((deleted) =>
      [...paths].some((path) => path.startsWith(`${deleted}/`) || deleted.startsWith(`${path}/`))
    )
  ) {
    throw new Error(
      'This workspace replaces a file with a directory or a directory with a file. Commit these structural changes before dispatching its source.'
    )
  }
  const warnings: string[] = []
  if (!before.baseCommit) {
    warnings.push(
      'This folder has no Git base commit; only explicitly selected files are included.'
    )
  }
  const files: CaptureFleetSourceResult['files'] = []
  const deletions: string[] = []
  const prepared: { path: string; absolute: string; stat: SourceStat }[] = []
  let total = 0
  for (const path of paths) {
    signal?.throwIfAborted()
    if (before.submodules.some((module) => path === module || path.startsWith(`${module}/`))) {
      throw new Error(
        `Submodule source snapshots are not supported: ${path}. Dispatch the submodule workspace separately.`
      )
    }
    const trackedChange = before.changes.includes(path)
    const requiredDeliverable = deliverables.paths.has(path)
    const absolute = await assertFleetSourcePath(
      io,
      root,
      path,
      trackedChange || requiredDeliverable
    )
    let fileStat: SourceStat
    try {
      fileStat = await io.lstat(absolute)
    } catch (error) {
      if (requiredDeliverable && isENOENT(error)) {
        throw new Error(`A declared handoff file is missing: ${path}`)
      }
      if (trackedChange && isENOENT(error)) {
        deletions.push(path)
        continue
      }
      throw error
    }
    if (fileStat.type !== 'file') {
      throw new Error(`Choose a regular source file: ${path}`)
    }
    const manifest = deliverables.manifests.get(path)
    if (manifest) {
      assertSameSourceStat(manifest.stat, fileStat)
    }
    if (!selected.has(path) && isImplicitFleetSecret(path)) {
      throw new Error(
        `The source snapshot includes a possible secret file: ${path}. Remove it from the snapshot or explicitly select it if you intend to share it.`
      )
    }
    if (fileStat.size > HANDOFF_FILE_MAX_BYTES) {
      throw new Error(`Source files must be at most 10 MiB: ${path}`)
    }
    total += fileStat.size
    prepared.push({ path, absolute, stat: fileStat })
    if (prepared.length > FLEET_SOURCE_MAX_FILES) {
      throw new Error(
        `A dispatch supports at most ${FLEET_SOURCE_MAX_FILES} source files plus its transcripts. Commit the workspace or select fewer files.`
      )
    }
    if (total > FLEET_SOURCE_MAX_BYTES) {
      throw new Error('The source snapshot exceeds the 32 MiB dispatch limit.')
    }
  }
  if (deletions.length > FLEET_SOURCE_MAX_DELETIONS) {
    throw new Error(
      `A dispatch supports at most ${FLEET_SOURCE_MAX_DELETIONS} tracked deletions. Commit these changes before dispatching.`
    )
  }
  const bytes = new Map<string, Buffer>()
  for (const entry of prepared) {
    signal?.throwIfAborted()
    await assertFleetSourcePath(io, root, entry.path)
    const content =
      deliverables.manifests.get(entry.path)?.bytes ??
      (await io.readExact(entry.absolute, HANDOFF_FILE_MAX_BYTES, entry.stat))
    if (content.length !== entry.stat.size) {
      throw new Error('A source file changed size during capture. Try again.')
    }
    const id = randomUUID()
    bytes.set(id, content)
    files.push({
      id,
      name: entry.path.split('/').at(-1)!,
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      targetPath: entry.path,
      executable: Boolean((entry.stat.mode ?? 0) & 0o111)
    })
  }
  for (const entry of prepared) {
    signal?.throwIfAborted()
    await assertFleetSourcePath(io, root, entry.path)
    assertSameSourceStat(entry.stat, await io.lstat(entry.absolute))
  }
  for (const path of deletions) {
    const absolute = await assertFleetSourcePath(io, root, path, true)
    try {
      await io.lstat(absolute)
    } catch (error) {
      if (isENOENT(error)) {
        continue
      }
      throw error
    }
    throw new Error('A deleted source file reappeared during capture. Try again.')
  }
  const rootAfter = await io.lstat(root)
  if (
    rootBefore.dev !== rootAfter.dev ||
    rootBefore.ino !== rootAfter.ino ||
    normalizeRuntimePathForComparison(await io.realpath(target.rootPath)) !==
      normalizeRuntimePathForComparison(root)
  ) {
    throw new Error('The source workspace moved during capture. Reopen dispatch and try again.')
  }
  assertFleetSourceGitUnchanged(
    before,
    await readFleetSourceGitState(git, request.includeUntracked)
  )
  signal?.throwIfAborted()
  return {
    manifest: {
      snapshotId: randomUUID(),
      ...(before.baseCommit ? { baseCommit: before.baseCommit } : {}),
      ...(before.remoteUrl ? { remoteUrl: before.remoteUrl } : {}),
      ...(before.branch ? { branch: before.branch } : {}),
      files,
      deletions,
      warnings,
      source: { connectionId: target.connectionId ?? null },
      ...(deliverables.deliverables
        ? {
            deliverables: deliverables.deliverables,
            deliverablePaths: [...deliverables.paths]
          }
        : {})
    },
    bytes
  }
}
