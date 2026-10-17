import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type {
  LocalWorkflowSaveResult,
  LocalWorkflowSaveResultRequest
} from '../../shared/local-workflow-rpc'
import type { LocalWorkflowView } from '../../shared/local-workflow-view'
import { workflowResultDocument } from '../../shared/workflow-graph-web'
import { durableWriteTempPath, renameDurable, writeTempFileDurable } from '../durable-file-write'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { getLocalWorkflowHost } from '../runtime/workflow-script/local-workflow-runtime-host'

const requestSchema = z
  .object({
    worktree: z.string().min(1).max(32_768),
    conversationId: z.string().min(1).max(512),
    executionId: z.string().uuid()
  })
  .strict()

function acceptedMarkdown(view: LocalWorkflowView, executionId: string): string {
  if (
    view.executionId !== executionId ||
    view.state !== 'completed' ||
    typeof view.result?.markdown !== 'string'
  ) {
    throw new Error('Only a completed workflow result can be saved.')
  }
  return workflowResultDocument(view.result)
}

/** The renderer supplies only an execution anchor. Content and destination stay in the main host. */
export async function saveLocalWorkflowResult(
  runtime: OrcaRuntimeService,
  event: IpcMainInvokeEvent,
  untrustedRequest: unknown
): Promise<LocalWorkflowSaveResult> {
  if (event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Workflow result save must originate from the current main frame.')
  }
  const parent = BrowserWindow.fromWebContents(event.sender)
  if (!parent) {
    throw new Error('Workflow result save requires a desktop window.')
  }
  const request: LocalWorkflowSaveResultRequest = requestSchema.parse(untrustedRequest)
  const host = await getLocalWorkflowHost(runtime)
  const initial = await host.show(request)
  const markdown = acceptedMarkdown(initial, request.executionId)
  const sha256 = createHash('sha256').update(markdown).digest('hex')
  const { canceled, filePath } = await dialog.showSaveDialog(parent, {
    title: 'Save workflow result',
    defaultPath: `${initial.preset}-${request.executionId.slice(0, 8)}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (canceled || !filePath) {
    return { saved: false, cancelled: true }
  }
  // A save panel may stay open while the execution changes. Reauthorize the persisted anchor.
  const current = await host.show(request)
  if (
    acceptedMarkdown(current, request.executionId) !== markdown ||
    current.fence !== initial.fence ||
    current.sequence !== initial.sequence
  ) {
    throw new Error('Workflow result changed while the save dialog was open. Try again.')
  }
  const tempPath = durableWriteTempPath(filePath)
  try {
    // Save results are private by default, including when replacing an existing 0600 file.
    await writeTempFileDurable(tempPath, markdown, 0o600)
    await renameDurable(tempPath, filePath)
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
  return { saved: true, filePath, executionId: request.executionId, sha256 }
}

export function registerLocalWorkflowResultSaveHandler(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler('runtime:saveLocalWorkflowResult')
  ipcMain.handle('runtime:saveLocalWorkflowResult', (event, request: unknown) =>
    saveLocalWorkflowResult(runtime, event, request)
  )
}
