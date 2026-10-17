import { BrowserWindow, ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { SESSION_WORKFLOW_RECORDS_SYNC_CHANNEL } from '../../shared/session-workflow-records'

/**
 * The window publishes its own workflow conversations to its own main process (session counts,
 * step 9); main carries them to paired clients beside each workspace snapshot.
 */
export function registerSessionWorkflowRecordsHandler(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler(SESSION_WORKFLOW_RECORDS_SYNC_CHANNEL)
  ipcMain.handle(SESSION_WORKFLOW_RECORDS_SYNC_CHANNEL, (event, publication: unknown): void => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      throw new Error('Workflow records must originate from a BrowserWindow')
    }
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Workflow records must originate from the current main frame')
    }
    runtime.syncSessionWorkflowRecords(window.id, publication)
  })
}
