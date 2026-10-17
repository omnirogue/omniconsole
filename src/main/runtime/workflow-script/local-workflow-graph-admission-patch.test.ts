import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import type { WorkflowCheck } from '../../../shared/workflow-graph'
import { workflowTemplate } from '../../../shared/workflow-graph-templates'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import { IMPROVE_RULES } from './graph/graph-improve-rules'
import { prepareGraphWorkflowAdmission } from './local-workflow-graph-admission'
import { hostCatalog } from './local-workflow-host.test-fixtures'

const CODE: WorkflowCheck = { command: 'npm test', apply: 'patch', protect: ['tests/**'] }
const folders: string[] = []

async function folder(git: boolean): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'improve-admission-')))
  folders.push(path)
  await writeFile(join(path, 'value.mjs'), 'export const value = 1\n')
  if (git) {
    await gitExecFileAsync(['init', '--quiet'], { cwd: path })
    await gitExecFileAsync(['config', 'user.name', 'Admission test'], { cwd: path })
    await gitExecFileAsync(['config', 'user.email', 'admission@example.invalid'], { cwd: path })
    await gitExecFileAsync(['add', '.'], { cwd: path })
    await gitExecFileAsync(['commit', '--quiet', '-m', 'start'], { cwd: path })
  }
  return path
}

afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function admit(path: string, check: WorkflowCheck = CODE) {
  const draft = createLocalWorkflowDraft('council', 'Make value 2')
  draft.concurrency = 2
  draft.access = 'workspace-read'
  const spec = workflowTemplate('improve', ['claude', 'codex', 'grok'])
  draft.graph = {
    spec: { ...spec, repeat: { ...spec.repeat!, check } },
    team: hostCatalog.map(({ agent, accountId }, index) => ({
      id: `seat-${index + 1}`,
      agent,
      accountId
    }))
  }
  const admitted = await prepareGraphWorkflowAdmission({
    request: {
      worktree: 'workspace-a',
      conversationId: 'conversation-a',
      requestId: 'request-1',
      preset: 'council',
      draft
    },
    workspace: { id: 'workspace-a', path, label: 'App' },
    requestDigest: 'digest',
    slotLimit: 6,
    catalog: async () => hostCatalog,
    freezeScope: async () => ({ evidence: '', sources: [], coverage: [] }),
    freezeWorkspaceRoot: async (root) => ({ path: root, device: '1', inode: '2' })
  })
  return admitted.snapshot
}

describe('admitting Improve with changes to the code', () => {
  it("freezes the clean commit every private copy starts from, with the person's check", async () => {
    const path = await folder(true)
    const head = await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: path })
    const snapshot = await admit(path)
    expect(snapshot.host.checkSource).toEqual({ sourceBase: head.stdout.trim() })
    expect(snapshot.host.improveRules).toBe(IMPROVE_RULES)
    expect(snapshot.graph?.spec.repeat?.check).toEqual(CODE)
  })

  it('refuses a workspace with uncommitted or untracked changes', async () => {
    const path = await folder(true)
    await writeFile(join(path, 'notes.txt'), 'not committed')
    await expect(admit(path)).rejects.toThrow('uncommitted or untracked changes')
  })

  it("refuses a folder inside a repository, which is not the repository's top folder", async () => {
    const path = await folder(true)
    await mkdir(join(path, 'inner'))
    await expect(admit(join(path, 'inner'))).rejects.toThrow("Git repository's top folder")
  })

  it('refuses a folder workspace, which keeps the text check', async () => {
    const path = await folder(false)
    await expect(admit(path)).rejects.toThrow('Choose "Text" for what each version is.')
    const text = await admit(path, { command: 'npm test' })
    expect(text.host.checkSource).toBeUndefined()
    expect(text.graph?.spec.repeat?.check).toEqual({ command: 'npm test' })
  })
})
