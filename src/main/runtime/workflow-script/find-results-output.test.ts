import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'
import { workflowTemplate } from '../../../shared/workflow-graph-templates'
import { projectFindResults, saveFindResults } from './find-results-output'
import { freezeWorkflowWorkspaceRoot } from './local-workflow-workspace-root'

let scratch: string
let workspace: string
let records: string
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'omni-find-results-')))
  workspace = join(scratch, 'workspace')
  records = join(scratch, 'records')
  await mkdir(workspace)
})
afterEach(() => rm(scratch, { recursive: true, force: true }))

const FILES = { markdown: '# Find the best\n', csv: '\uFEFFrank,option\r\n1,A\r\n' }

function completedView(): LocalWorkflowView {
  return {
    executionId: '3f9a1c2e-0000-4000-8000-000000000000',
    state: 'completed',
    prompt: 'Name the bakery',
    startedAt: new Date(2026, 8, 23, 8, 5).getTime(),
    result: { markdown: '## Best option: A', sources: [], coverage: [] },
    graphRun: {
      spec: workflowTemplate('find', ['claude']),
      find: {
        stage: 'done',
        pool: 2,
        source: 'list',
        top: 2,
        overall: [],
        byCriterion: [],
        criteria: [],
        rows: [
          { key: 'a', title: 'A', detail: '', by: 'your list', scores: [], kept: true },
          { key: 'b', title: 'B', detail: '', by: 'your list', scores: [] }
        ]
      }
    }
  } as unknown as LocalWorkflowView
}

describe('saving Find results in the workspace', () => {
  it('writes both files once into .omni/find, which git ignores', async () => {
    const root = await freezeWorkflowWorkspaceRoot(workspace)
    const saved = await saveFindResults(root, 'run', FILES)
    const folder = join(workspace, '.omni', 'find')
    expect(saved).toEqual({
      folder,
      files: [join(folder, 'run.md'), join(folder, 'run.csv')]
    })
    expect(await readFile(join(folder, 'run.csv'), 'utf8')).toBe(FILES.csv)
    expect(await readFile(join(folder, '.gitignore'), 'utf8')).toBe('*\n')
    // The same bytes again count as written; different bytes never replace a file.
    await expect(saveFindResults(root, 'run', FILES)).resolves.toEqual(saved)
    await expect(saveFindResults(root, 'run', { ...FILES, markdown: 'edited' })).rejects.toThrow(
      'already exists with different content'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a results folder that is a link out of the workspace, and writes nothing there',
    async () => {
      const outside = join(scratch, 'outside')
      await mkdir(outside)
      await symlink(outside, join(workspace, '.omni'))
      const root = await freezeWorkflowWorkspaceRoot(workspace)
      await expect(saveFindResults(root, 'run', FILES)).rejects.toThrow('is not a plain folder')
      expect(await readdir(outside)).toEqual([])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a workspace replaced since the run started',
    async () => {
      const root = await freezeWorkflowWorkspaceRoot(workspace)
      const elsewhere = join(scratch, 'elsewhere')
      await mkdir(elsewhere)
      await rm(workspace, { recursive: true })
      await symlink(elsewhere, workspace)
      await expect(saveFindResults(root, 'run', FILES)).rejects.toThrow('was moved or replaced')
      expect(await readdir(elsewhere)).toEqual([])
    }
  )

  it('saves a completed run once, then reports where it went without writing again', async () => {
    const root = await freezeWorkflowWorkspaceRoot(workspace)
    const first = await projectFindResults(completedView(), root, records)
    const saved = first.graphRun!.find!.saved as { folder: string; files: string[] }
    expect(saved.files.map((file) => basename(file))).toEqual([
      '2026-09-23-0805-name-the-bakery-3f9a1c2e.md',
      '2026-09-23-0805-name-the-bakery-3f9a1c2e.csv'
    ])
    expect(await readFile(saved.files[0]!, 'utf8')).toContain('## Every option, best first (2)')
    // A person who tidies the folder is not undone: the record says where they went.
    await rm(saved.folder, { recursive: true })
    const again = await projectFindResults(completedView(), root, records)
    expect(again.graphRun!.find!.saved).toEqual(saved)
    await expect(readdir(saved.folder)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('shows why the files could not be written, and tries again next time', async () => {
    const root = await freezeWorkflowWorkspaceRoot(workspace)
    await writeFile(join(workspace, '.omni'), 'a file, not a folder')
    const failed = await projectFindResults(completedView(), root, records)
    expect(failed.graphRun!.find!.saved).toMatchObject({ error: expect.any(String) })
    await rm(join(workspace, '.omni'))
    const retried = await projectFindResults(completedView(), root, records)
    expect(retried.graphRun!.find!.saved).toMatchObject({ files: expect.any(Array) })
  })

  it('leaves runs that did not complete, or have no results, as they are', async () => {
    const root = await freezeWorkflowWorkspaceRoot(workspace)
    const running = { ...completedView(), state: 'running' } as LocalWorkflowView
    expect(await projectFindResults(running, root, records)).toBe(running)
    await expect(readdir(workspace)).resolves.toEqual([])
  })
})
