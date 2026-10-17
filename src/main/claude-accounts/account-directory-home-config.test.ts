import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncHomeClaudeConfigIntoAccountDirectory } from './account-directory-home-config'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, symlinkSync: vi.fn(actual.symlinkSync) }
})

const roots: string[] = []
afterEach(() => {
  vi.mocked(symlinkSync).mockClear()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function setup(home: { instructions?: string; settings?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claude-home-config-'))
  roots.push(root)
  const homeClaudeDir = join(root, 'home-claude')
  const configDir = join(root, 'account')
  mkdirSync(homeClaudeDir)
  mkdirSync(configDir)
  if (home.instructions !== undefined) {
    writeFileSync(join(homeClaudeDir, 'CLAUDE.md'), home.instructions)
  }
  if (home.settings !== undefined) {
    writeFileSync(join(homeClaudeDir, 'settings.json'), home.settings)
  }
  return { homeClaudeDir, configDir }
}

const settings = (value: Record<string, unknown>) => `${JSON.stringify(value, null, 2)}\n`

describe('CLAUDE.md in a managed account directory', () => {
  it('links the home file so the rules load once and stay current', () => {
    const { homeClaudeDir, configDir } = setup({ instructions: '# rules v1\n' })
    const result = syncHomeClaudeConfigIntoAccountDirectory(configDir, homeClaudeDir)
    expect(result.instructions).toBe('linked')
    const link = join(configDir, 'CLAUDE.md')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(join(homeClaudeDir, 'CLAUDE.md'))
    writeFileSync(join(homeClaudeDir, 'CLAUDE.md'), '# rules v2\n')
    expect(readFileSync(link, 'utf8')).toBe('# rules v2\n')
    expect(syncHomeClaudeConfigIntoAccountDirectory(configDir, homeClaudeDir).instructions).toBe(
      'kept'
    )
  })

  it('replaces an earlier copy with the link and keeps a hand-edited copy beside it', () => {
    const { homeClaudeDir, configDir } = setup({ instructions: '# rules v2\n' })
    writeFileSync(join(configDir, 'CLAUDE.md'), '# rules v1, edited by hand\n')
    expect(syncHomeClaudeConfigIntoAccountDirectory(configDir, homeClaudeDir).instructions).toBe(
      'linked'
    )
    expect(lstatSync(join(configDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true)
    const backups = readdirSync(configDir).filter((name) => name.startsWith('CLAUDE.md.replaced-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(configDir, backups[0]), 'utf8')).toBe('# rules v1, edited by hand\n')
  })

  it('drops an identical copy without leaving a backup', () => {
    const { homeClaudeDir, configDir } = setup({ instructions: '# rules\n' })
    writeFileSync(join(configDir, 'CLAUDE.md'), '# rules\n')
    syncHomeClaudeConfigIntoAccountDirectory(configDir, homeClaudeDir)
    expect(lstatSync(join(configDir, 'CLAUDE.md')).isSymbolicLink()).toBe(true)
    expect(readdirSync(configDir)).toEqual(['CLAUDE.md'])
  })

  it('re-points a link that names another file', () => {
    const { homeClaudeDir, configDir } = setup({ instructions: '# rules\n' })
    const elsewhere = join(homeClaudeDir, 'OLD.md')
    writeFileSync(elsewhere, '# old\n')
    symlinkSync(elsewhere, join(configDir, 'CLAUDE.md'), 'file')
    expect(syncHomeClaudeConfigIntoAccountDirectory(configDir, homeClaudeDir).instructions).toBe(
      'linked'
    )
    expect(readlinkSync(join(configDir, 'CLAUDE.md'))).toBe(join(homeClaudeDir, 'CLAUDE.md'))
  })

  it('leaves the account untouched when the home file is absent', () => {
    const { homeClaudeDir, configDir } = setup()
    writeFileSync(join(configDir, 'CLAUDE.md'), '# account only\n')
    expect(syncHomeClaudeConfigIntoAccountDirectory(configDir, homeClaudeDir).instructions).toBe(
      'absent'
    )
    expect(readFileSync(join(configDir, 'CLAUDE.md'), 'utf8')).toBe('# account only\n')
  })

  it('falls back to a refreshed copy when the platform refuses file links', () => {
    const { homeClaudeDir, configDir } = setup({ instructions: '# rules v2\n' })
    writeFileSync(join(configDir, 'CLAUDE.md'), '# rules v1\n')
    vi.mocked(symlinkSync).mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })
    expect(syncHomeClaudeConfigIntoAccountDirectory(configDir, homeClaudeDir).instructions).toBe(
      'copied'
    )
    expect(lstatSync(join(configDir, 'CLAUDE.md')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(configDir, 'CLAUDE.md'), 'utf8')).toBe('# rules v2\n')
    expect(syncHomeClaudeConfigIntoAccountDirectory(configDir, homeClaudeDir).instructions).toBe(
      'kept'
    )
    expect(readdirSync(configDir).filter((name) => name.includes('replaced'))).toEqual([])
  })
})

describe('settings.json in a managed account directory', () => {
  it('copies the whole home file on first use', () => {
    const home = settings({ permissions: { allow: ['Bash(ls:*)'] }, theme: 'dark' })
    const { homeClaudeDir, configDir } = setup({ settings: home })
    expect(syncHomeClaudeConfigIntoAccountDirectory(configDir, homeClaudeDir).policySettings).toBe(
      'copied'
    )
    expect(readFileSync(join(configDir, 'settings.json'), 'utf8')).toBe(home)
  })

  it('mirrors permissions and env on later launches and keeps the account choices', () => {
    const { homeClaudeDir, configDir } = setup({
      settings: settings({
        permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(git push --force:*)'] },
        env: { ESTATE: 'main' },
        theme: 'dark'
      })
    })
    writeFileSync(
      join(configDir, 'settings.json'),
      settings({
        permissions: { allow: ['Bash(ls:*)'] },
        theme: 'light',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'managed.sh' }] }] }
      })
    )
    expect(syncHomeClaudeConfigIntoAccountDirectory(configDir, homeClaudeDir).policySettings).toBe(
      'mirrored'
    )
    const written = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
    expect(written).toEqual({
      permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(git push --force:*)'] },
      env: { ESTATE: 'main' },
      theme: 'light',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'managed.sh' }] }] }
    })
    expect(syncHomeClaudeConfigIntoAccountDirectory(configDir, homeClaudeDir).policySettings).toBe(
      'unchanged'
    )
  })

  it('removes a policy key the home file no longer carries', () => {
    const { homeClaudeDir, configDir } = setup({ settings: settings({ theme: 'dark' }) })
    writeFileSync(join(configDir, 'settings.json'), settings({ env: { OLD: '1' }, theme: 'dark' }))
    syncHomeClaudeConfigIntoAccountDirectory(configDir, homeClaudeDir)
    expect(JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))).toEqual({
      theme: 'dark'
    })
  })

  it('refreshes the compaction window on existing accounts without changing model choices', () => {
    const { homeClaudeDir, configDir } = setup({
      settings: settings({ autoCompactWindow: 200_000, model: 'opus', effortLevel: 'high' })
    })
    const accountChoices = {
      model: 'sonnet',
      effortLevel: 'low',
      modelSettings: { 'claude-sonnet-5': { effortLevel: 'medium' } },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'managed.sh' }] }] }
    }
    writeFileSync(join(configDir, 'settings.json'), settings(accountChoices))
    const sync = () => syncHomeClaudeConfigIntoAccountDirectory(configDir, homeClaudeDir)
    expect(sync().policySettings).toBe('mirrored')
    expect(JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))).toEqual({
      ...accountChoices,
      autoCompactWindow: 200_000
    })
    expect(sync().policySettings).toBe('unchanged')

    writeFileSync(join(homeClaudeDir, 'settings.json'), settings({ autoCompactWindow: 150_000 }))
    expect(sync().policySettings).toBe('mirrored')
    expect(JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))).toEqual({
      ...accountChoices,
      autoCompactWindow: 150_000
    })

    writeFileSync(join(homeClaudeDir, 'settings.json'), settings({}))
    expect(sync().policySettings).toBe('mirrored')
    expect(JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))).toEqual(
      accountChoices
    )
  })

  it('never rewrites the account settings from an unreadable home file', () => {
    const { homeClaudeDir, configDir } = setup({ settings: '{ not json' })
    const account = settings({ permissions: { allow: ['Bash(ls:*)'] } })
    writeFileSync(join(configDir, 'settings.json'), account)
    expect(syncHomeClaudeConfigIntoAccountDirectory(configDir, homeClaudeDir).policySettings).toBe(
      'skipped'
    )
    expect(readFileSync(join(configDir, 'settings.json'), 'utf8')).toBe(account)
    expect(existsSync(join(configDir, 'settings.json.bak'))).toBe(false)
  })
})
