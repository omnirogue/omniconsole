import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { locateTranscripts, readTranscriptCwd } from './session-transcript-locate'

const ID = '2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c'
let root: string
let home: string
let userData: string

function write(path: string, lines: unknown[]): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n'))
  return path
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'transcript-locate-')))
  home = join(root, 'home')
  userData = join(root, 'app')
  mkdirSync(home, { recursive: true })
  mkdirSync(userData, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('locateTranscripts', () => {
  it('finds a Claude conversation kept under an OmniConsole-managed account', async () => {
    const configDir = join(userData, 'claude-accounts', 'acct-1', 'auth', 'session')
    const path = write(join(configDir, 'projects', '-w', `${ID}.jsonl`), [{ type: 'summary' }])
    expect(
      await locateTranscripts('claude', ID, { userDataPath: userData, homeDir: home })
    ).toEqual([{ path, providerRoot: configDir, defaultRoot: false }])
  })

  it('marks the default home, and returns every copy so a copied id reads as ambiguous', async () => {
    const own = write(join(home, '.claude', 'projects', '-w', `${ID}.jsonl`), [{}])
    const copy = write(join(home, '.claude-work', 'projects', '-w', `${ID}.jsonl`), [{}])
    const found = await locateTranscripts('claude', ID, { userDataPath: userData, homeDir: home })
    expect(found).toEqual(
      expect.arrayContaining([
        { path: own, providerRoot: join(home, '.claude'), defaultRoot: true },
        { path: copy, providerRoot: join(home, '.claude-work'), defaultRoot: false }
      ])
    )
    expect(found).toHaveLength(2)
  })

  it('reads Codex history hardlinked into several account homes as one conversation', async () => {
    const name = `rollout-2026-09-25T10-00-00-${ID}.jsonl`
    const homeA = join(userData, 'codex-accounts', 'a1', 'home')
    const homeB = join(userData, 'codex-accounts', 'b2', 'home')
    const path = write(join(homeA, 'sessions', '2026', '09', '25', name), [{}])
    const linked = join(homeB, 'sessions', '2026', '09', '25', name)
    mkdirSync(join(linked, '..'), { recursive: true })
    linkSync(path, linked)
    expect(await locateTranscripts('codex', ID, { userDataPath: userData, homeDir: home })).toEqual(
      [{ path, providerRoot: homeA, defaultRoot: false }]
    )
  })

  it('resumes hardlinked Codex history under the account whose index records the thread', async () => {
    const name = `rollout-2026-10-17T13-50-00-${ID}.jsonl`
    const other = join(userData, 'codex-accounts', 'a1', 'home')
    const ranUnder = join(userData, 'codex-accounts', 'b2', 'home')
    const first = write(join(other, 'sessions', '2026', '10', '17', name), [{}])
    const linked = join(ranUnder, 'sessions', '2026', '10', '17', name)
    mkdirSync(join(linked, '..'), { recursive: true })
    linkSync(first, linked)
    const db = new SyncDatabase(join(ranUnder, 'state_5.sqlite'))
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY); INSERT INTO threads (id) VALUES ('${ID}')`)
    db.close()
    expect(await locateTranscripts('codex', ID, { userDataPath: userData, homeDir: home })).toEqual(
      [{ path: linked, providerRoot: ranUnder, defaultRoot: false }]
    )
  })

  it('finds a Codex rollout by the id at the end of its name', async () => {
    const codexHome = join(userData, 'codex-accounts', 'a1', 'home')
    const path = write(
      join(codexHome, 'sessions', '2026', '09', '25', `rollout-2026-09-25T10-00-00-${ID}.jsonl`),
      [{}]
    )
    expect(await locateTranscripts('codex', ID, { userDataPath: userData, homeDir: home })).toEqual(
      [{ path, providerRoot: codexHome, defaultRoot: false }]
    )
    expect(
      await locateTranscripts('claude', ID, { userDataPath: userData, homeDir: home })
    ).toEqual([])
  })
})

describe('readTranscriptCwd', () => {
  it('reads the folder the conversation ran in from its first recorded cwd', async () => {
    const claude = write(join(root, 'c.jsonl'), [
      { type: 'summary', summary: 'x' },
      { type: 'user', cwd: '/Users/maintainer/work/app', message: { role: 'user', content: 'hi' } },
      { type: 'user', cwd: '/elsewhere', message: { role: 'user', content: 'later' } }
    ])
    expect(await readTranscriptCwd('claude', claude)).toBe('/Users/maintainer/work/app')
    const codex = write(join(root, 'x.jsonl'), [
      { type: 'session_meta', payload: { id: ID, cwd: '/Users/maintainer/work/api' } }
    ])
    expect(await readTranscriptCwd('codex', codex)).toBe('/Users/maintainer/work/api')
    expect(await readTranscriptCwd('claude', join(root, 'missing.jsonl'))).toBeNull()
  })
})
