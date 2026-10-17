import type { WorkflowContextRecordEntry } from '../../../../shared/workflow-context-layout'
import type { LocalWorkflowHostSnapshot } from '../local-workflow-host-snapshot'

function described(entry: WorkflowContextRecordEntry): string {
  if (entry.kind === 'workspace') {
    return `${entry.folder}/ (the project the person has open)`
  }
  if (entry.kind === 'path') {
    return `${entry.folder} (a copy of ${entry.path})`
  }
  const commit = entry.commit ? `, commit ${entry.commit.slice(0, 12)}` : ''
  return `${entry.folder}/ (GitHub ${entry.repo} at ${entry.ref ?? 'its default branch'}${commit})`
}

/**
 * What agents are told about a context folder: its top-level entries and where each came from.
 * A pure function of the snapshot, so a replay rebuilds the same prompts.
 */
export function graphContextNote(entries: readonly WorkflowContextRecordEntry[]): string {
  return `The current directory holds read-only copies of what the person chose: ${entries
    .map(described)
    .join('; ')}.`
}

/** The note for a run that reads a context folder; nothing for any other run. */
export function graphContextNoteFields(
  snapshot: Partial<Pick<LocalWorkflowHostSnapshot, 'host'>>
): { workspaceNote?: string } {
  // Snapshots from other programs (and tests) may carry no host at all.
  const entries = snapshot.host?.context?.entries
  return entries?.length ? { workspaceNote: graphContextNote(entries) } : {}
}
