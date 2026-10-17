import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertWorkflowReadableRoot,
  workflowCodexHiddenPaths,
  workflowCredentialPaths,
  workflowGrokDeniedPaths,
  workflowPathWithin,
  workflowRootContainsHome
} from './local-workflow-read-scope'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A fake home folder with credentials, a provider account home and a workspace. */
function home(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-read-scope-')))
  directories.push(root)
  for (const folder of ['.ssh', '.config/omni', '.claude-account-5', '.grok/bin', 'code/repo']) {
    mkdirSync(join(root, folder), { recursive: true })
  }
  for (const file of ['.zshenv', '.grok/auth.json', '.grok/config.toml', '.grok/notes.md']) {
    writeFileSync(join(root, file), '')
  }
  mkdirSync(join(root, '.grok', 'sessions'))
  return root
}

describe('workflow read scope', () => {
  it('matches a folder and its contents, not a sibling with the same prefix', () => {
    expect(workflowPathWithin('/home/sal', '/home/sal')).toBe(true)
    expect(workflowPathWithin('/home/sal/repo/a.ts', '/home/sal/repo')).toBe(true)
    expect(workflowPathWithin('/home/sal/repo-2', '/home/sal/repo')).toBe(false)
    expect(workflowPathWithin('/home/sal', '/')).toBe(true)
  })

  it('lists the credential locations that exist, including provider account homes', async () => {
    const folder = home()
    expect((await workflowCredentialPaths(folder)).sort()).toEqual(
      ['.claude-account-5', '.config', '.grok', '.ssh', '.zshenv'].map((name) => join(folder, name))
    )
  })

  it('refuses a workspace that is the home folder or holds it, by path or by identity', async () => {
    const folder = home()
    for (const root of [folder, dirname(folder), '/']) {
      expect(await workflowRootContainsHome(root, folder)).toBe(true)
    }
    // Another spelling of the home folder (here a link to it) is still the home folder.
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-alias-')))
    directories.push(other)
    symlinkSync(folder, join(other, 'home'))
    expect(await workflowRootContainsHome(join(other, 'home'), folder)).toBe(true)
    // A folder that holds the home folder under its own path, as /System/Volumes/Data holds /Users.
    const users = join(other, 'Users')
    mkdirSync(join(users, 'sal'), { recursive: true })
    mkdirSync(join(other, 'data'))
    symlinkSync(users, join(other, 'data', 'Users'))
    expect(await workflowRootContainsHome(join(other, 'data'), join(users, 'sal'))).toBe(true)
    expect(await workflowRootContainsHome(join(users, 'sal', 'repo'), join(users, 'sal'))).toBe(
      false
    )
    await expect(assertWorkflowReadableRoot(folder, folder)).rejects.toThrow(
      `Agents can't read ${folder}: it contains your home folder`
    )
    const repo = join(folder, 'code', 'repo')
    expect(await workflowRootContainsHome(repo, folder)).toBe(false)
    await expect(assertWorkflowReadableRoot(repo, folder)).resolves.toBeUndefined()
  })

  it('hides the home folder and other data outside it from Codex, never the workspace', async () => {
    const folder = home()
    const temporary = process.platform === 'darwin' ? '/private/tmp' : '/tmp'
    const hidden = await workflowCodexHiddenPaths(join(folder, 'code', 'repo'), folder)
    // Other agents' tool output lives in temporary folders; the workspace is the narrower read.
    expect(hidden[0]).toBe(folder)
    expect(hidden).toContain(temporary)
    expect(new Set(hidden).size).toBe(hidden.length)
    // A data folder the workspace lies in stays readable to it.
    const inside = await workflowCodexHiddenPaths(temporary, folder)
    expect(inside).toContain(folder)
    expect(inside).not.toContain(temporary)
  })

  it('denies Grok the account home except its login, and never a path Grok needs', async () => {
    const folder = home()
    const account = join(folder, '.grok')
    const denied = await workflowGrokDeniedPaths({
      account,
      needed: ['/data/attempt'],
      root: join(folder, 'code', 'repo'),
      home: folder
    })
    expect(denied.sort()).toEqual(
      ['config.toml', 'notes.md', 'sessions'].map((name) => join(account, name))
    )
    // A workspace that contains the home folder also hides the credentials, but not the account.
    const wide = await workflowGrokDeniedPaths({ account, needed: [], root: folder, home: folder })
    expect(wide).toEqual(expect.arrayContaining([join(folder, '.ssh'), join(folder, '.zshenv')]))
    expect(wide).not.toContain(account)
    expect(wide).not.toContain(join(account, 'auth.json'))
  })
})
