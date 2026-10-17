import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeGlobalConfigPaths, keepClaudeDiffPanelClosed } from './claude-diff-panel-preference'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claude-diff-panel-'))
  mkdirSync(join(home, '.claude'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function writeJson(path: string, value: unknown, mode = 0o600): void {
  writeFileSync(path, JSON.stringify(value), { mode })
}

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>

describe('claudeGlobalConfigPaths', () => {
  it('covers both files the default config dir can be read from', () => {
    expect(claudeGlobalConfigPaths(join(home, '.claude'), {}, home)).toEqual([
      join(home, '.claude', '.claude.json'),
      join(home, '.claude.json')
    ])
  })

  it('reads only the account directory a managed launch points CLAUDE_CONFIG_DIR at', () => {
    const account = join(home, 'accounts', 'slot-3')
    expect(claudeGlobalConfigPaths(account, { CLAUDE_CONFIG_DIR: account }, home)).toEqual([
      join(account, '.claude.json')
    ])
  })

  it('prefers a legacy .config.json and names the custom OAuth file', () => {
    const account = join(home, 'acct')
    mkdirSync(account)
    const env = { CLAUDE_CONFIG_DIR: account, CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://x' }
    expect(claudeGlobalConfigPaths(account, env, home)).toEqual([
      join(account, '.claude-custom-oauth.json')
    ])
    writeJson(join(account, '.config.json'), {})
    expect(claudeGlobalConfigPaths(account, env, home)).toEqual([join(account, '.config.json')])
  })
})

describe('keepClaudeDiffPanelClosed', () => {
  it('records the pane as closed, keeping every other key and the file mode', () => {
    const path = join(home, '.claude.json')
    writeJson(path, { numStartups: 4, projects: { '/repo': { hasTrustDialogAccepted: true } } })
    expect(keepClaudeDiffPanelClosed(join(home, '.claude'), {}, home)).toBe(1)
    expect(readJson(path)).toEqual({
      numStartups: 4,
      projects: { '/repo': { hasTrustDialogAccepted: true } },
      diffSidebarOpen: false
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('closes a pane the person kept open before, in every default file that exists', () => {
    writeJson(join(home, '.claude.json'), { diffSidebarOpen: true })
    writeJson(join(home, '.claude', '.claude.json'), {})
    expect(keepClaudeDiffPanelClosed(join(home, '.claude'), {}, home)).toBe(2)
    expect(readJson(join(home, '.claude.json')).diffSidebarOpen).toBe(false)
    expect(readJson(join(home, '.claude', '.claude.json')).diffSidebarOpen).toBe(false)
  })

  it('leaves an already closed, missing or unreadable config untouched', () => {
    const path = join(home, '.claude.json')
    expect(keepClaudeDiffPanelClosed(join(home, '.claude'), {}, home)).toBe(0)
    writeJson(path, { diffSidebarOpen: false, keep: 1 })
    const before = readFileSync(path, 'utf-8')
    expect(keepClaudeDiffPanelClosed(join(home, '.claude'), {}, home)).toBe(0)
    expect(readFileSync(path, 'utf-8')).toBe(before)
    writeFileSync(path, '{ not json')
    expect(keepClaudeDiffPanelClosed(join(home, '.claude'), {}, home)).toBe(0)
    expect(readFileSync(path, 'utf-8')).toBe('{ not json')
  })

  it('waits for a running Claude that holds the config lock, and releases its own', () => {
    const path = join(home, '.claude.json')
    writeJson(path, { keep: 1 })
    mkdirSync(`${path}.lock`)
    expect(keepClaudeDiffPanelClosed(join(home, '.claude'), {}, home)).toBe(0)
    expect(readJson(path)).toEqual({ keep: 1 })
    expect(existsSync(`${path}.lock`)).toBe(true)
    rmSync(`${path}.lock`, { recursive: true })
    expect(keepClaudeDiffPanelClosed(join(home, '.claude'), {}, home)).toBe(1)
    expect(readJson(path)).toEqual({ keep: 1, diffSidebarOpen: false })
    expect(existsSync(`${path}.lock`)).toBe(false)
  })

  it('leaves no temporary file behind and keeps the config present throughout', () => {
    const path = join(home, '.claude.json')
    writeJson(path, { keep: 1 })
    expect(keepClaudeDiffPanelClosed(join(home, '.claude'), {}, home)).toBe(1)
    expect(readdirSync(home).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('updates a symlinked config through its link, keeping the link', () => {
    const managed = join(home, 'managed.json')
    writeJson(managed, { keep: 1 })
    symlinkSync(managed, join(home, '.claude.json'))
    expect(keepClaudeDiffPanelClosed(join(home, '.claude'), {}, home)).toBe(1)
    expect(lstatSync(join(home, '.claude.json')).isSymbolicLink()).toBe(true)
    expect(readJson(managed)).toEqual({ keep: 1, diffSidebarOpen: false })
    expect(existsSync(`${join(home, '.claude.json')}.lock`)).toBe(false)
  })

  it('never writes outside the account directory of a managed launch', () => {
    writeJson(join(home, '.claude.json'), {})
    const account = join(home, 'accounts', 'slot-1')
    mkdirSync(account, { recursive: true })
    writeJson(join(account, '.claude.json'), {})
    expect(keepClaudeDiffPanelClosed(account, { CLAUDE_CONFIG_DIR: account }, home)).toBe(1)
    expect(readJson(join(home, '.claude.json')).diffSidebarOpen).toBeUndefined()
  })
})
