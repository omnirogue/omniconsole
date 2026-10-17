import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { localWorkflowOutputProblem } from '../../../shared/local-workflow-output'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import { workflowResultDocument } from '../../../shared/workflow-graph-web'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import type Database from '../../sqlite/sync-database'
import { ensureFrozenFolderFile } from './frozen-folder-file'
import { projectFindResults } from './find-results-output'

type Output = NonNullable<LocalWorkflowHostSnapshot['host']['output']>

export async function prepareLocalWorkflowOutput(root: string, fileName: string): Promise<Output> {
  const problem = localWorkflowOutputProblem(fileName)
  if (problem || !fileName) {
    throw new Error(problem ?? 'Choose a Markdown output filename.')
  }
  const filePath = join(root, fileName)
  const directory = await lstat(root, { bigint: true })
  if (!directory.isDirectory() || (await realpath(root)) !== root) {
    throw new Error('Council output root changed before admission.')
  }
  try {
    await lstat(filePath)
    throw new Error(`Output file already exists: ${filePath}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  return { root, fileName, device: String(directory.dev), inode: String(directory.ino) }
}

/** Publish accepted Markdown once. A crash after link is recognized by its exact bytes on recovery. */
export async function ensureLocalWorkflowOutput(
  output: Output,
  markdown: string
): Promise<{ filePath: string; sha256: string }> {
  const problem = localWorkflowOutputProblem(output.fileName)
  if (problem || !output.fileName) {
    throw new Error(problem ?? 'Missing Council output filename.')
  }
  return ensureFrozenFolderFile(output, markdown)
}

export async function projectLocalWorkflowOutput(
  view: LocalWorkflowView,
  store: WorkflowCheckpointStore
): Promise<LocalWorkflowView> {
  if (view.preset !== 'council' || view.state !== 'completed' || !view.result) {
    return view
  }
  const snapshot = store.inspect(view.executionId, view.fence).snapshot as LocalWorkflowHostSnapshot
  if (snapshot.host.resultsRoot && view.graphRun?.find) {
    return projectFindResults(view, snapshot.host.resultsRoot)
  }
  if (!snapshot.host.output) {
    return view
  }
  try {
    return {
      ...view,
      savedOutput: await ensureLocalWorkflowOutput(
        snapshot.host.output,
        workflowResultDocument(view.result)
      )
    }
  } catch (error) {
    return { ...view, outputError: error instanceof Error ? error.message : String(error) }
  }
}

/** Complete a file publish interrupted after the workflow's completed checkpoint. */
export async function reconcileCompletedLocalWorkflowOutputs(
  db: Database.Database,
  store: WorkflowCheckpointStore,
  project: (executionId: string) => LocalWorkflowView
): Promise<void> {
  const rows = db
    .prepare(
      "SELECT id FROM local_workflow_executions WHERE preset='council' AND state='completed'"
    )
    .all() as { id: string }[]
  for (const row of rows) {
    try {
      await projectLocalWorkflowOutput(project(row.id), store)
    } catch {
      // The visible Show projection reports any evidence or file error for this execution.
    }
  }
}
