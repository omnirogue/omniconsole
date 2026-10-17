import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertWorkflowContextPath, workflowExpandHome } from './context-source-check'
import { workflowContextCredentialName, workflowContextSkippedName } from './context-exclusions'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A fake home folder with credentials, app data and a project. */
function home(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-context-check-')))
  directories.push(root)
  for (const folder of ['.ssh', '.config/omni', '.claude-work', 'app-data', 'code/repo/docs']) {
    mkdirSync(join(root, folder), { recursive: true })
  }
  writeFileSync(join(root, 'code', 'repo', 'README.md'), 'hi')
  writeFileSync(join(root, 'code', 'repo', '.env.local'), 'SECRET=1')
  return root
}

describe('which chosen files and folders agents may read', () => {
  it('accepts a project folder or file and returns its real path', async () => {
    const folder = home()
    await expect(
      assertWorkflowContextPath(join(folder, 'code', 'repo'), { home: folder })
    ).resolves.toEqual({ path: join(folder, 'code', 'repo'), directory: true })
    await expect(
      assertWorkflowContextPath('~/code/repo/README.md', { home: folder })
    ).resolves.toEqual({ path: join(folder, 'code', 'repo', 'README.md'), directory: false })
  })

  it('refuses the home folder and anything that holds it', async () => {
    const folder = home()
    for (const path of [folder, dirname(folder), '~']) {
      await expect(assertWorkflowContextPath(path, { home: folder })).rejects.toThrow(
        'it contains your home folder'
      )
    }
  })

  it('refuses credential locations, anything inside them and the app data folder', async () => {
    const folder = home()
    for (const path of [
      join(folder, '.ssh'),
      join(folder, '.config', 'omni'),
      join(folder, '.claude-work'),
      join(folder, 'code', 'repo', '.env.local'),
      join(folder, 'app-data')
    ]) {
      await expect(
        assertWorkflowContextPath(path, { home: folder, appData: join(folder, 'app-data') })
      ).rejects.toThrow('it is where logins, keys or app data are kept')
    }
  })

  it('follows a link to what it points at before deciding', async () => {
    const folder = home()
    symlinkSync(join(folder, '.ssh'), join(folder, 'code', 'keys'))
    await expect(
      assertWorkflowContextPath(join(folder, 'code', 'keys'), { home: folder })
    ).rejects.toThrow('it is where logins, keys or app data are kept')
  })

  it('refuses a relative or missing path in plain words', async () => {
    const folder = home()
    await expect(assertWorkflowContextPath('code/repo', { home: folder })).rejects.toThrow(
      'is not a full path'
    )
    await expect(assertWorkflowContextPath(join(folder, 'gone'), { home: folder })).rejects.toThrow(
      "can't be found"
    )
  })

  it('spells ~ from the home folder', () => {
    expect(workflowExpandHome('~', '/h')).toBe('/h')
    expect(workflowExpandHome('~/a/b', '/h')).toBe(join('/h', 'a/b'))
    expect(workflowExpandHome('/x/~/y', '/h')).toBe('/x/~/y')
  })

  it('names credentials at any depth, and skips packages and Git data when copying', () => {
    for (const name of ['.ssh', '.ENV', '.env.production', '.netrc', '.codex-2', '.gitconfig']) {
      expect(workflowContextCredentialName(name)).toBe(true)
    }
    for (const name of ['src', 'env', '.envrc-example', 'README.md']) {
      expect(workflowContextCredentialName(name)).toBe(false)
    }
    expect(workflowContextSkippedName('node_modules')).toBe(true)
    expect(workflowContextSkippedName('.git')).toBe(true)
    expect(workflowContextSkippedName('.github')).toBe(false)
  })
})
