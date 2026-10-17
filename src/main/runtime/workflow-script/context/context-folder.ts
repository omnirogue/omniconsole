import { randomBytes } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  workflowContextLayout,
  type WorkflowContextRecordEntry
} from '../../../../shared/workflow-context-layout'
import type { WorkflowContextSource } from '../../../../shared/workflow-context-sources'
import { copyWorkflowContextTree, WorkflowContextBudget } from './context-copy'
import { cloneWorkflowContextRepo } from './context-github-clone'
import { workflowPathWithin } from '../local-workflow-read-scope'
import { assertWorkflowContextPath } from './context-source-check'

/** A context folder's name: its creation time first, so a sweep can age it without reading it. */
export function workflowContextFolderName(now: number, suffix: string): string {
  return `ctx-${String(now).padStart(13, '0')}-${suffix}`
}

export type WorkflowContextMaterialized = { root: string; entries: WorkflowContextRecordEntry[] }

/**
 * Builds one run's private context folder under `base`: the workspace (when included), each
 * chosen file or folder and each GitHub repository, laid out by workflowContextLayout. Every path
 * is checked before anything is copied; on any failure the folder is removed and the reason is
 * thrown in plain words.
 */
export async function materializeWorkflowContext(input: {
  base: string
  workspacePath: string
  sources: readonly WorkflowContextSource[]
  includeWorkspace: boolean
  home?: string
  appData?: string
  now?: number
  clone?: typeof cloneWorkflowContextRepo
}): Promise<WorkflowContextMaterialized> {
  const layout = workflowContextLayout(input.sources, input.includeWorkspace)
  if (!layout.length) {
    throw new Error('Choose at least one file, folder or repo for the agents to read.')
  }
  const check = { home: input.home, appData: input.appData }
  const local = await Promise.all(
    layout.map((entry) =>
      entry.kind === 'github'
        ? Promise.resolve(undefined)
        : assertWorkflowContextPath(
            entry.kind === 'workspace' ? input.workspacePath : entry.path,
            check
          )
    )
  )
  await mkdir(input.base, { recursive: true })
  const base = await realpath(input.base)
  // A folder holding the context folders would copy each run's copy into itself.
  const holdsBase = local.find((found) => found && workflowPathWithin(base, found.path))
  if (holdsBase) {
    throw new Error(`Agents can't read ${holdsBase.path}: it holds this app's own data.`)
  }
  const root = join(
    base,
    workflowContextFolderName(input.now ?? Date.now(), randomBytes(4).toString('hex'))
  )
  await mkdir(root)
  const budget = new WorkflowContextBudget()
  const entries: WorkflowContextRecordEntry[] = []
  try {
    for (const [index, entry] of layout.entries()) {
      const target = join(root, ...entry.folder.split('/'))
      if (entry.kind !== 'github') {
        await copyWorkflowContextTree(local[index]!.path, target, budget)
        entries.push(entry)
        continue
      }
      // Cloned aside, then copied like any folder: links and .git never reach the agents.
      const staging = join(root, '.staging', String(index))
      await mkdir(join(root, '.staging'), { recursive: true })
      const { commit } = await (input.clone ?? cloneWorkflowContextRepo)({
        repo: entry.repo,
        ...(entry.ref ? { ref: entry.ref } : {}),
        target: staging
      })
      await copyWorkflowContextTree(staging, target, budget)
      await rm(staging, { recursive: true, force: true, maxRetries: 2 })
      entries.push({ ...entry, commit })
    }
    await rm(join(root, '.staging'), { recursive: true, force: true, maxRetries: 2 })
  } catch (error) {
    await rm(root, { recursive: true, force: true, maxRetries: 2 }).catch(() => {})
    throw error
  }
  return { root, entries }
}
