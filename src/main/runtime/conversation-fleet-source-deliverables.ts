import { HANDOFF_FILE_MAX_BYTES } from '../../shared/console-handoff-contract'
import {
  FLEET_SOURCE_MAX_BYTES,
  FLEET_SOURCE_MAX_FILES
} from '../../shared/conversation-fleet-source-snapshot'
import { parseDeliverablesManifest } from '../../shared/session-follow-up-deliverables'
import type { SessionFollowUpDeliverables } from '../../shared/session-follow-up-rule-fields'
import {
  assertFleetSourcePath,
  type FleetSourceIo,
  type SourceStat
} from './conversation-fleet-source-io'
import { joinWorktreeRelativePath } from './runtime-relative-paths'

type CapturedDeliverables = {
  paths: Set<string>
  deliverables?: SessionFollowUpDeliverables
  manifests: Map<string, { stat: SourceStat; bytes: Buffer }>
}

export async function captureFleetSourceDeliverables(args: {
  io: FleetSourceIo
  root: string
  sourceWorkspacePath?: string
  deliverables?: SessionFollowUpDeliverables
  relativePath: (input: string) => string
  signal?: AbortSignal
}): Promise<CapturedDeliverables> {
  const { io, root, sourceWorkspacePath, deliverables, relativePath, signal } = args
  const paths = new Set<string>()
  const manifests: CapturedDeliverables['manifests'] = new Map()
  const addPath = (input: string): string => {
    const path = relativePath(input)
    paths.add(path)
    if (paths.size > FLEET_SOURCE_MAX_FILES) {
      throw new Error(
        `A dispatch supports at most ${FLEET_SOURCE_MAX_FILES} source files, including deliverable manifests. Select fewer files.`
      )
    }
    return path
  }
  signal?.throwIfAborted()
  if (!deliverables) {
    return { paths, manifests }
  }
  if (deliverables.kind === 'files') {
    deliverables.paths.forEach(addPath)
    return { paths, manifests, deliverables: { kind: 'files', paths: [...paths] } }
  }
  const manifestPaths = [
    ...new Set(
      (deliverables.kind === 'manifest'
        ? [deliverables.manifestPath]
        : deliverables.manifestPaths
      ).map(addPath)
    )
  ]
  const prepared: { path: string; absolute: string; stat: SourceStat }[] = []
  let total = 0
  for (const path of manifestPaths) {
    signal?.throwIfAborted()
    const absolute = await assertFleetSourcePath(io, root, path)
    const stat = await io.lstat(absolute)
    if (stat.type !== 'file') {
      throw new Error(`Choose a regular deliverables manifest: ${path}`)
    }
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new Error(`The source host returned an invalid manifest size: ${path}`)
    }
    if (stat.size > HANDOFF_FILE_MAX_BYTES) {
      throw new Error(`Deliverable manifests must be at most 10 MiB: ${path}`)
    }
    total += stat.size
    if (total > FLEET_SOURCE_MAX_BYTES) {
      throw new Error('The source snapshot exceeds the 32 MiB dispatch limit.')
    }
    prepared.push({ path, absolute, stat })
  }
  for (const entry of prepared) {
    signal?.throwIfAborted()
    await assertFleetSourcePath(io, root, entry.path)
    const bytes = await io.readExact(entry.absolute, HANDOFF_FILE_MAX_BYTES, entry.stat)
    signal?.throwIfAborted()
    if (bytes.length !== entry.stat.size) {
      throw new Error('A deliverables manifest changed size during capture. Try again.')
    }
    let markdown: string
    try {
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error(`Deliverables manifests must contain valid UTF-8 text: ${entry.path}`)
    }
    // Apply the file limit while parsing, before a large manifest expands into an unbounded list.
    for (const line of markdown.split(/\r?\n/)) {
      let parsed = parseDeliverablesManifest(line, entry.absolute, root)
      if (parsed.refused.length > 0 && sourceWorkspacePath && sourceWorkspacePath !== root) {
        parsed = parseDeliverablesManifest(
          line,
          joinWorktreeRelativePath(sourceWorkspacePath, entry.path),
          sourceWorkspacePath
        )
      }
      if (parsed.refused.length > 0) {
        throw new Error(
          `The deliverables manifest lists a file outside this workspace: ${parsed.refused[0]}`
        )
      }
      parsed.paths.forEach(addPath)
    }
    manifests.set(entry.path, { stat: entry.stat, bytes })
  }
  return {
    paths,
    manifests,
    deliverables:
      deliverables.kind === 'manifest'
        ? { kind: 'manifest', manifestPath: manifestPaths[0]! }
        : { kind: 'manifests', manifestPaths }
  }
}
