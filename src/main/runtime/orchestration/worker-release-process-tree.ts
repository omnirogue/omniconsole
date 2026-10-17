import { z } from 'zod'
import type { OrcaRuntimeService } from '../omni-runtime'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'
import { parseWorkerTerminalHostScope } from './worker-terminal-process-liveness'
import {
  captureDescendantSnapshot,
  hasUnambiguousStartIdentity,
  type DescendantSnapshot
} from '../../pty-descendant-termination'
import { terminateDescendantSnapshotWithVerdict } from '../../pty-descendant-exit-verification'

const processRow = z.object({
  pid: z.number().int().min(2),
  ppid: z.number().int().nonnegative(),
  pgid: z.number().int().nonnegative(),
  startedAt: z.string().min(1)
})
const savedTree = z.object({
  version: z.literal(1),
  processIncarnation: z.string().min(1),
  hostScope: z.string().min(1),
  snapshot: z.object({
    root: z.object({ pid: z.number().int().min(2), startedAt: z.string().min(1) }),
    rootPgid: z.number().int().nullable(),
    descendants: z.array(processRow),
    capturedAtMs: z.number().positive()
  })
})
export type WorkerReleaseProcessTree = z.infer<typeof savedTree>

export function readWorkerReleaseProcessTree(
  content: string,
  resource: WorkerTerminalResourceRow
): WorkerReleaseProcessTree | null {
  try {
    const parsed = savedTree.safeParse(JSON.parse(content)?.releaseProcessTree)
    return parsed.success &&
      parsed.data.processIncarnation === resource.process_incarnation &&
      parsed.data.hostScope === resource.host_scope &&
      parseWorkerTerminalHostScope(resource.host_scope)?.kind === 'local'
      ? parsed.data
      : null
  } catch {
    return null
  }
}

/** Capture before root close, while parent links and exact owner evidence still exist. */
export async function captureWorkerReleaseProcessTree(
  runtime: OrcaRuntimeService,
  resource: WorkerTerminalResourceRow
): Promise<WorkerReleaseProcessTree> {
  if (
    process.platform === 'win32' ||
    parseWorkerTerminalHostScope(resource.host_scope)?.kind !== 'local'
  ) {
    throw new Error('Disposable worker descendant ownership is unavailable on this host.')
  }
  const proof = (await runtime.readTerminalProcessEvidence(resource.terminal_handle))?.proof
  if (
    !proof?.incarnationId ||
    `${proof.ptyId}:${proof.incarnationId}` !== resource.process_incarnation
  ) {
    throw new Error('Disposable worker process identity is unavailable.')
  }
  const snapshot = await captureDescendantSnapshot(proof.rootPid)
  const current = (await runtime.readTerminalProcessEvidence(resource.terminal_handle))?.proof
  if (
    !snapshot?.root ||
    !snapshot.descendants.some((row) => row.pid === proof.pid) ||
    snapshot.descendants.some((row) => !hasUnambiguousStartIdentity(row, snapshot.capturedAtMs)) ||
    !current ||
    JSON.stringify(current) !== JSON.stringify(proof) ||
    runtime.getTerminalProcessIncarnation(resource.terminal_handle) !== resource.process_incarnation
  ) {
    throw new Error('Disposable worker descendant identity changed during capture.')
  }
  return {
    version: 1,
    processIncarnation: resource.process_incarnation!,
    hostScope: resource.host_scope!,
    snapshot: {
      root: snapshot.root,
      rootPgid: snapshot.rootPgid,
      descendants: snapshot.descendants,
      capturedAtMs: snapshot.capturedAtMs
    }
  }
}

/** Reuse the existing identity-revalidated escalation and observed exit verdict, never root exit alone. */
export function finishWorkerReleaseProcessTree(tree: WorkerReleaseProcessTree) {
  return terminateDescendantSnapshotWithVerdict(tree.snapshot as DescendantSnapshot, {
    requireIdentityBeforeSignal: true
  })
}

/** A live retry keeps earlier detached children and adds children born while release was held. */
export function mergeWorkerReleaseProcessTrees(
  previous: WorkerReleaseProcessTree,
  current: WorkerReleaseProcessTree
): WorkerReleaseProcessTree {
  if (
    previous.processIncarnation !== current.processIncarnation ||
    previous.hostScope !== current.hostScope ||
    previous.snapshot.root.pid !== current.snapshot.root.pid ||
    previous.snapshot.root.startedAt !== current.snapshot.root.startedAt
  ) {
    throw new Error('Disposable worker root identity changed before release retry.')
  }
  const descendants = new Map(previous.snapshot.descendants.map((row) => [row.pid, row]))
  for (const row of current.snapshot.descendants) {
    descendants.set(row.pid, row)
  }
  return { ...current, snapshot: { ...current.snapshot, descendants: [...descendants.values()] } }
}
