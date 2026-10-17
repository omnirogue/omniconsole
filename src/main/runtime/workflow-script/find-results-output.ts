import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import type { WorkflowFindSaved } from '../../../shared/workflow-find-trail'
import { findJudgeStep } from '../../../shared/workflow-graph-find'
import { findResultsCsv, findResultsMarkdown, findResultsStem } from './find-results-files'
import { ensureFrozenFolderFile } from './frozen-folder-file'
import {
  assertFrozenWorkspaceFolder,
  type LocalWorkflowWorkspaceRoot
} from './local-workflow-workspace-root'

/** Where in the workspace every Find the best run keeps its results. */
const FIND_RESULTS_FOLDER = ['.omni', 'find'] as const

/** Makes the results folder one part at a time; a part that is a link, or moved, is refused. */
async function resultsFolder(root: LocalWorkflowWorkspaceRoot) {
  let current = await assertFrozenWorkspaceFolder(root)
  for (const part of FIND_RESULTS_FOLDER) {
    current = join(current, part)
    await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error
      }
    })
    if (!(await lstat(current)).isDirectory() || (await realpath(current)) !== current) {
      throw new Error(`${current} is not a plain folder, so the results were not written there.`)
    }
  }
  // Results are per run, not project files: the folder ignores itself in a repository.
  await writeFile(join(current, '.gitignore'), '*\n', { flag: 'wx' }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error
      }
    }
  )
  const folder = await lstat(current, { bigint: true })
  return { root: current, device: String(folder.dev), inode: String(folder.ino) }
}

/** Writes the run's results files once; the same bytes already there count as written. */
export async function saveFindResults(
  root: LocalWorkflowWorkspaceRoot,
  stem: string,
  files: { markdown: string; csv: string }
): Promise<{ folder: string; files: string[] }> {
  const folder = await resultsFolder(root)
  const written: string[] = []
  for (const [extension, content] of [
    ['md', files.markdown],
    ['csv', files.csv]
  ] as const) {
    written.push(
      (await ensureFrozenFolderFile({ ...folder, fileName: `${stem}.${extension}` }, content))
        .filePath
    )
  }
  return { folder: folder.root, files: written }
}

function recordPath(executionId: string, base?: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(executionId)) {
    throw new Error('Invalid workflow execution id')
  }
  return join(
    base ?? join(getAppEnvironment().getPath('userData'), 'local-workflow-attempts'),
    executionId,
    'find-results.json'
  )
}

/** Where a run's results were written; once recorded, they are never written again. */
export function readFindResultsRecord(
  executionId: string,
  base?: string
): { folder: string; files: string[] } | undefined {
  try {
    const path = recordPath(executionId, base)
    if (!existsSync(path)) {
      return undefined
    }
    const record = JSON.parse(readFileSync(path, 'utf8')) as { folder?: unknown; files?: unknown }
    return typeof record.folder === 'string' &&
      Array.isArray(record.files) &&
      record.files.every((file) => typeof file === 'string')
      ? { folder: record.folder, files: record.files as string[] }
      : undefined
  } catch {
    return undefined
  }
}

function writeFindResultsRecord(
  executionId: string,
  saved: { folder: string; files: string[] },
  base?: string
): void {
  const path = recordPath(executionId, base)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(saved), { mode: 0o600 })
}

/**
 * A completed Find the best run saves every option and score in its workspace, once: the first
 * view after it completes writes the files, and later views read where they went. A failure is
 * shown on the run and tried again next time; a person who moves or edits the files is not undone.
 */
export async function projectFindResults(
  view: LocalWorkflowView,
  root: LocalWorkflowWorkspaceRoot,
  base?: string
): Promise<LocalWorkflowView> {
  const trail = view.graphRun?.find
  if (view.state !== 'completed' || !view.result || !trail?.rows?.length) {
    return view
  }
  let saved: WorkflowFindSaved | undefined = readFindResultsRecord(view.executionId, base)
  if (!saved) {
    try {
      const judge = findJudgeStep(view.graphRun!.spec)
      const written = await saveFindResults(
        root,
        findResultsStem(view.prompt, view.startedAt, view.executionId),
        {
          markdown: findResultsMarkdown({
            task: view.prompt,
            rubric: judge?.instruction ?? '',
            report: view.result.markdown,
            trail
          }),
          csv: findResultsCsv(trail)
        }
      )
      writeFindResultsRecord(view.executionId, written, base)
      saved = written
    } catch (error) {
      saved = { error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { ...view, graphRun: { ...view.graphRun!, find: { ...trail, saved } } }
}
