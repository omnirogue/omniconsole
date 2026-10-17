/** The real readings behind `readArchiveSleepHost`: the window's rows, Stage A1 and up next. */

import { observeSession } from '../session-manage/session-manage-observe'
import { readSidebarRows } from '../session-manage/session-manage-runtime-actions'
import {
  createRuntimeObserveSources,
  runtimeNeverReplied,
  snapshotRuntimeLatestTurn
} from '../session-manage/session-manage-runtime-sources'
import { projectSessionState } from '../session-manage/session-manage-state'
import { archiveSleepReplies, type ArchiveSleepHostDeps } from './archive-sleep-host-reading'
import type { OrcaRuntimeService } from './omni-runtime'
import { upNextView } from './up-next'

export function runtimeArchiveSleepHostDeps(runtime: OrcaRuntimeService): ArchiveSleepHostDeps {
  const sources = createRuntimeObserveSources(runtime)
  return {
    rows: () => readSidebarRows(runtime),
    state: async (row) => projectSessionState((await observeSession(row, sources)).facts).state,
    replies: (source) =>
      archiveSleepReplies(
        snapshotRuntimeLatestTurn(source, runtimeNeverReplied(runtime)),
        runtime.getLastAgentHookRowForPane(source.paneKey)
      ),
    nothingPending: async (source) => (await upNextView(runtime, source)).archiveSleepClear === true
  }
}
