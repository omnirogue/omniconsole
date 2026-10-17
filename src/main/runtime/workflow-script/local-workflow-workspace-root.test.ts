import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertWorkflowWorkspaceRoot,
  freezeWorkflowWorkspaceRoot
} from './local-workflow-workspace-root'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function workspace() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-root-')))
  directories.push(parent)
  const root = join(parent, 'repo')
  mkdirSync(root)
  return { parent, root }
}

describe('workflow workspace root identity', () => {
  it('freezes the canonical folder and accepts it unchanged', async () => {
    const { parent, root } = workspace()
    const link = join(parent, 'link')
    symlinkSync(root, link)
    const frozen = await freezeWorkflowWorkspaceRoot(link)
    expect(frozen.path).toBe(root)
    expect(frozen.device).toMatch(/^\d+$/)
    expect(frozen.inode).toMatch(/^\d+$/)
    await expect(assertWorkflowWorkspaceRoot({ host: host(frozen) })).resolves.toBe(root)
  })

  it('refuses a folder that was replaced, moved away or never frozen', async () => {
    const { parent, root } = workspace()
    const frozen = await freezeWorkflowWorkspaceRoot(root)
    renameSync(root, join(parent, 'moved'))
    await expect(assertWorkflowWorkspaceRoot({ host: host(frozen) })).rejects.toThrow('missing')
    mkdirSync(root)
    await expect(assertWorkflowWorkspaceRoot({ host: host(frozen) })).rejects.toThrow(
      'moved or replaced'
    )
    await expect(assertWorkflowWorkspaceRoot({ host: host(undefined) })).rejects.toThrow(
      'no workspace folder'
    )
  })

  it('refuses a folder path that now resolves through a symlink', async () => {
    const { parent, root } = workspace()
    const frozen = await freezeWorkflowWorkspaceRoot(root)
    renameSync(root, join(parent, 'real'))
    symlinkSync(join(parent, 'real'), root)
    await expect(assertWorkflowWorkspaceRoot({ host: host(frozen) })).rejects.toThrow(
      'moved or replaced'
    )
  })
})

function host(workspaceRoot: { path: string; device: string; inode: string } | undefined) {
  return {
    workspaceId: 'workspace',
    conversationId: 'conversation',
    requestDigest: 'digest',
    startedAt: 1,
    concurrency: 1,
    sources: [],
    coverage: [],
    ...(workspaceRoot ? { workspaceRoot } : {})
  }
}
