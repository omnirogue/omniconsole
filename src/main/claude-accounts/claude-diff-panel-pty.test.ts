import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keepClaudeDiffPanelClosedForPty } from './claude-diff-panel-pty'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claude-diff-pty-'))
  mkdirSync(join(home, '.claude'))
  // Why: the code merges process.env, so the shell's own Claude config must never be the target.
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

const config = (path: string) => JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>

describe('keepClaudeDiffPanelClosedForPty', () => {
  it('prepares the config a Claude launch reads, from the launch’s own home', () => {
    writeFileSync(join(home, '.claude.json'), '{}')
    keepClaudeDiffPanelClosedForPty({ env: { HOME: home }, launchAgent: 'claude' })
    expect(config(join(home, '.claude.json')).diffSidebarOpen).toBe(false)
  })

  it('follows the launch’s CLAUDE_CONFIG_DIR, leaving the default config alone', () => {
    const account = join(home, 'accounts', 'a1')
    mkdirSync(account, { recursive: true })
    writeFileSync(join(account, '.claude.json'), '{}')
    writeFileSync(join(home, '.claude.json'), '{}')
    keepClaudeDiffPanelClosedForPty({
      env: { HOME: home, CLAUDE_CONFIG_DIR: account },
      launchAgent: 'claude-agent-teams'
    })
    expect(config(join(account, '.claude.json')).diffSidebarOpen).toBe(false)
    expect(config(join(home, '.claude.json')).diffSidebarOpen).toBeUndefined()
  })

  it('does nothing for other agents or a plain shell', () => {
    writeFileSync(join(home, '.claude.json'), '{}')
    keepClaudeDiffPanelClosedForPty({ env: { HOME: home }, launchAgent: 'codex' })
    keepClaudeDiffPanelClosedForPty({ env: { HOME: home } })
    expect(config(join(home, '.claude.json')).diffSidebarOpen).toBeUndefined()
  })
})
