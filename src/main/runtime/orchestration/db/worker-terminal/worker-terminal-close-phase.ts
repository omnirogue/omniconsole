import type {
  WorkerTerminalArchiveRow,
  WorkerTerminalResourceRow
} from '../../worker-terminal-ownership'

export type WorkerTerminalClosePhase = 'prepared' | 'issued' | 'unknown'

function archiveObject(content: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Worker terminal archive content is not an object.')
  }
  return parsed as Record<string, unknown>
}

export function readWorkerTerminalClosePhase(
  archive: WorkerTerminalArchiveRow | undefined,
  resource: WorkerTerminalResourceRow
): WorkerTerminalClosePhase {
  if (!archive || archive.resource_id !== resource.id) {
    return 'unknown'
  }
  try {
    const phase = archiveObject(archive.content).releaseClosePhase
    if (!phase || typeof phase !== 'object' || Array.isArray(phase)) {
      return 'unknown'
    }
    const record = phase as Record<string, unknown>
    return record.version === 1 &&
      record.resourceId === resource.id &&
      record.ownerDispatchId === resource.owner_dispatch_id &&
      record.processIncarnation === resource.process_incarnation &&
      record.hostScope === resource.host_scope &&
      (record.state === 'prepared' || record.state === 'issued')
      ? record.state
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function archiveWithWorkerTerminalClosePhase(
  content: string,
  resource: WorkerTerminalResourceRow,
  state: 'prepared' | 'issued'
): string {
  return JSON.stringify({
    ...archiveObject(content),
    releaseClosePhase: {
      version: 1,
      state,
      resourceId: resource.id,
      ownerDispatchId: resource.owner_dispatch_id,
      processIncarnation: resource.process_incarnation,
      hostScope: resource.host_scope
    }
  })
}

export function archiveWithoutWorkerTerminalClosePhase(content: string): string {
  const archive = archiveObject(content)
  delete archive.releaseClosePhase
  return JSON.stringify(archive)
}

export function archiveWithPriorWorkerTerminalClosePhase(
  content: string,
  priorContent: string
): string {
  const archive = archiveObject(content)
  const prior = archiveObject(priorContent)
  delete archive.releaseClosePhase
  if (prior.releaseClosePhase !== undefined) {
    archive.releaseClosePhase = prior.releaseClosePhase
  }
  return JSON.stringify(archive)
}

export function archiveHasWorkerTerminalClosePhase(content: string): boolean {
  try {
    return archiveObject(content).releaseClosePhase !== undefined
  } catch {
    return true
  }
}
