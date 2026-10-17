import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyWorkflowContextTree, WorkflowContextBudget } from './context-copy'
import { materializeWorkflowContext, workflowContextFolderName } from './context-folder'
import {
  discardWorkflowContextFolder,
  sweepWorkflowContextFolders,
  WORKFLOW_CONTEXT_KEEP_MS,
  workflowContextFoldersToPrune
} from './context-sweep'

vi.mock('../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/nowhere' })
}))

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporary(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  directories.push(root)
  return root
}

/** A fake home with a secret, a workspace and a notes folder full of things never to copy. */
function home(): string {
  const root = temporary('workflow-context-folder-')
  for (const folder of [
    '.ssh',
    'work/app/src',
    'work/app/node_modules/pkg',
    'work/app/.git/objects',
    'notes/.aws'
  ]) {
    mkdirSync(join(root, folder), { recursive: true })
  }
  writeFileSync(join(root, '.ssh', 'id_ed25519'), 'KEY')
  writeFileSync(join(root, 'work', 'app', 'src', 'index.ts'), 'export {}')
  writeFileSync(join(root, 'work', 'app', 'node_modules', 'pkg', 'index.js'), '')
  writeFileSync(join(root, 'work', 'app', '.env'), 'TOKEN=1')
  writeFileSync(join(root, 'notes', 'plan.md'), '# plan')
  writeFileSync(join(root, 'notes', '.aws', 'credentials'), 'AWS')
  // A link out of the folder must never let an agent reach the key.
  symlinkSync(join(root, '.ssh'), join(root, 'notes', 'keys'))
  return root
}

describe('a run context folder', () => {
  it('copies the workspace, folders and repos into their own folders, secrets left out', async () => {
    const folder = home()
    const base = temporary('workflow-context-base-')
    const clone = vi.fn(async ({ target }: { target: string }) => {
      mkdirSync(join(target, '.git'), { recursive: true })
      writeFileSync(join(target, 'README.md'), 'repo')
      symlinkSync('/etc', join(target, 'escape'))
      return { commit: 'a'.repeat(40) }
    })
    const made = await materializeWorkflowContext({
      base,
      workspacePath: join(folder, 'work', 'app'),
      sources: [
        { kind: 'path', path: '~/notes' },
        { kind: 'path', path: join(folder, 'notes', 'plan.md') },
        { kind: 'github', repo: 'acme/api', ref: 'dev' }
      ],
      includeWorkspace: true,
      home: folder,
      now: 1_700_000_000_000,
      clone
    })
    expect(made.root.startsWith(join(base, 'ctx-1700000000000-'))).toBe(true)
    expect(made.entries).toEqual([
      { kind: 'workspace', folder: 'workspace' },
      { kind: 'path', path: '~/notes', folder: 'notes' },
      { kind: 'path', path: join(folder, 'notes', 'plan.md'), folder: 'plan.md' },
      {
        kind: 'github',
        repo: 'acme/api',
        ref: 'dev',
        folder: 'github/acme__api@dev',
        commit: 'a'.repeat(40)
      }
    ])
    expect(readdirSync(made.root).sort()).toEqual(['github', 'notes', 'plan.md', 'workspace'])
    expect(readFileSync(join(made.root, 'workspace', 'src', 'index.ts'), 'utf8')).toBe('export {}')
    expect(readFileSync(join(made.root, 'plan.md'), 'utf8')).toBe('# plan')
    expect(readdirSync(join(made.root, 'workspace')).sort()).toEqual(['src'])
    expect(readdirSync(join(made.root, 'notes'))).toEqual(['plan.md'])
    expect(readdirSync(join(made.root, 'github', 'acme__api@dev'))).toEqual(['README.md'])
    expect(clone).toHaveBeenCalledWith({ repo: 'acme/api', ref: 'dev', target: expect.any(String) })
  })

  it('refuses before copying anything and leaves no folder behind', async () => {
    const folder = home()
    const base = temporary('workflow-context-base-')
    await expect(
      materializeWorkflowContext({
        base,
        workspacePath: join(folder, 'work', 'app'),
        sources: [{ kind: 'path', path: join(folder, '.ssh') }],
        includeWorkspace: true,
        home: folder
      })
    ).rejects.toThrow('it is where logins, keys or app data are kept')
    await expect(
      materializeWorkflowContext({
        base,
        workspacePath: folder,
        sources: [],
        includeWorkspace: true,
        home: folder
      })
    ).rejects.toThrow('it contains your home folder')
    expect(readdirSync(base)).toEqual([])
  })

  it('removes a half-made folder when a copy fails', async () => {
    const folder = home()
    const base = temporary('workflow-context-base-')
    await expect(
      materializeWorkflowContext({
        base,
        workspacePath: join(folder, 'work', 'app'),
        sources: [{ kind: 'github', repo: 'acme/api' }],
        includeWorkspace: true,
        home: folder,
        clone: async () => {
          throw new Error('acme/api was not found, or your GitHub login can’t see it.')
        }
      })
    ).rejects.toThrow('acme/api was not found')
    expect(readdirSync(base)).toEqual([])
  })

  it('stops at the size cap with a plain reason', async () => {
    const source = temporary('workflow-context-big-')
    writeFileSync(join(source, 'a.bin'), Buffer.alloc(600))
    writeFileSync(join(source, 'b.bin'), Buffer.alloc(600))
    const target = join(temporary('workflow-context-target-'), 'copy')
    await expect(
      copyWorkflowContextTree(source, target, new WorkflowContextBudget(1000))
    ).rejects.toThrow('larger than')
  })
})

describe('keeping and removing context folders', () => {
  it('prunes only its own folders older than a week', () => {
    const now = 1_800_000_000_000
    const old = workflowContextFolderName(now - WORKFLOW_CONTEXT_KEEP_MS - 1, 'ab12')
    const fresh = workflowContextFolderName(now - 1000, 'cd34')
    expect(workflowContextFoldersToPrune([old, fresh, 'notes', 'ctx-12-zz'], now)).toEqual([old])
  })

  it('sweeps stale folders and discards only a folder inside the base', async () => {
    const base = temporary('workflow-context-sweep-')
    const now = Date.now()
    const old = join(base, workflowContextFolderName(now - WORKFLOW_CONTEXT_KEEP_MS - 1, 'aa'))
    const fresh = join(base, workflowContextFolderName(now, 'bb'))
    mkdirSync(old)
    mkdirSync(fresh)
    expect(await sweepWorkflowContextFolders(base, now)).toEqual([old.slice(base.length + 1)])
    expect(existsSync(fresh)).toBe(true)
    const outside = temporary('workflow-context-outside-')
    await discardWorkflowContextFolder(outside, base)
    expect(existsSync(outside)).toBe(true)
    await discardWorkflowContextFolder(fresh, base)
    expect(existsSync(fresh)).toBe(false)
  })
})
