import { isProjectFolder } from '../../../shared/session-project-folder'
import { sessionFolderTallies, type SessionFolderTally } from './session-folder-rollup'
import type { SessionFolderMetadata } from './session-folders'
import { sessionProjectThreads, type SessionProjectThreadInputs } from './session-project-threads'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'

/** Keep legacy folder totals; project review counts use the same ownership rules as the page. */
export function sessionProjectOverviewTallies(
  metadata: SessionFolderMetadata,
  rows: readonly SessionSidebarTreeRow[],
  inputs: Omit<SessionProjectThreadInputs, 'coordinatorSessionKey'>
): Map<string, SessionFolderTally> {
  const tallies = sessionFolderTallies(metadata.folders, rows, inputs.classifications ?? new Map())
  for (const folder of metadata.folders) {
    const tally = tallies.get(folder.id)
    if (!tally || !isProjectFolder(metadata.folders, folder.id)) {
      continue
    }
    const threads = sessionProjectThreads(metadata.folders, rows, folder.id, {
      ...inputs,
      coordinatorSessionKey: metadata.projects?.[folder.id]?.coordinator?.sessionKey
    })
    tally.reviewReady = threads.filter((thread) => thread.status === 'reviewReady').length
  }
  return tallies
}
