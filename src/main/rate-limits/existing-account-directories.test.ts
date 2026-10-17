import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverExistingAccountDirectories } from './existing-account-directories'

const homes: string[] = []
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })))

describe('existing account discovery', () => {
  it('finds numbered Claude profiles, nested pools, and all ten Codex homes', () => {
    const home = mkdtempSync(join(tmpdir(), 'account-discovery-'))
    homes.push(home)
    const add = (path: string, marker: string): void => {
      mkdirSync(join(home, path), { recursive: true })
      writeFileSync(join(home, path, marker), '{}')
    }
    add('.claude', '.claude.json')
    add('.claude-account-7', '.claude.json')
    add('.claude-accounts/sal/slot-16', '.credentials.json')
    add('.claude-accounts/backups', '.credentials.json')
    add('.claude-accounts/sal/slot-codex-sixth', 'auth.json')
    add('.codex-review-tmp', 'auth.json')
    add('.codex', 'auth.json')
    for (const suffix of [
      'second',
      'third',
      'fourth',
      'fifth',
      'sixth',
      'seventh',
      'eighth',
      'ninth',
      'tenth'
    ]) {
      add(`.codex-${suffix}`, 'auth.json')
    }
    const found = discoverExistingAccountDirectories(home)
    expect(found.filter((row) => row.provider === 'claude')).toHaveLength(3)
    expect(found.filter((row) => row.provider === 'codex')).toHaveLength(10)
    expect(
      found.some((row) => row.path.includes('backups') || row.path.includes('review-tmp'))
    ).toBe(false)
  })
})
