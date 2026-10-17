import { lstatSync, type Stats } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { admitsPeerInboxCodexSqliteRouting } from './peer-inbox-codex-sqlite-routing'

vi.mock('node:fs', () => ({ lstatSync: vi.fn() }))
vi.mock('../../shared/node-bounded-file-reader', () => ({
  readNodeFileSyncWithinLimit: vi.fn()
}))

const PROFILE = resolve('test-profile')
const record = () =>
  ({ accountHome: { variable: 'CODEX_HOME', path: PROFILE } }) as AgentSessionRecord
const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CODEX_SQLITE_HOME', undefined)
  vi.stubEnv('codex_sqlite_home', undefined)
  vi.mocked(lstatSync).mockImplementation(() => {
    throw missing
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function config(content: string): Buffer {
  const buffer = Buffer.from(content)
  vi.mocked(lstatSync).mockReturnValue({ isFile: () => true } as Stats)
  vi.mocked(readNodeFileSyncWithinLimit).mockImplementation(() => ({
    buffer: Buffer.from(buffer),
    stats: {} as Stats
  }))
  return buffer
}

describe('native Codex SQLite routing admission', () => {
  it('admits the default account-root route when optional configs are absent', () => {
    expect(admitsPeerInboxCodexSqliteRouting(record())).toBe(true)
  })

  it.each(['CODEX_SQLITE_HOME', 'codex_sqlite_home'])('refuses ambient %s', (key) => {
    vi.stubEnv(key, resolve('another-database'))
    expect(admitsPeerInboxCodexSqliteRouting(record())).toBe(false)
    expect(lstatSync).not.toHaveBeenCalled()
  })

  it('refuses Windows until its managed configuration root is attested', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    expect(admitsPeerInboxCodexSqliteRouting(record())).toBe(false)
  })

  it.each([
    '-c',
    '-csqlite_home=x',
    '--config=sqlite_home=x',
    '--config',
    '-p',
    '--profile=x',
    '-C',
    '--cd=x'
  ])('refuses recorded launch option %s whose routing is not pinned', (arg) => {
    expect(admitsPeerInboxCodexSqliteRouting({ ...record(), launchArgs: [arg] })).toBe(false)
  })

  it.each([
    'sqlite_home = "/another"',
    '"sqlite_home" = "/another"',
    "'sqlite_home' = '/another'",
    '"sqlite_\\u0068ome" = "/another"',
    '[profiles.work]\n sqlite_home = "/another"',
    'profiles.work.sqlite_home = "/another"'
  ])('refuses SQLite routing in a config assignment: %s', (content) => {
    config(content)
    expect(admitsPeerInboxCodexSqliteRouting(record())).toBe(false)
  })

  it('admits unrelated configuration without reinterpreting it', () => {
    config('model = "codex"\n# sqlite_home = "/inactive"')
    expect(admitsPeerInboxCodexSqliteRouting(record())).toBe(true)
  })

  it('refuses unreadable configuration', () => {
    vi.mocked(lstatSync).mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })
    expect(admitsPeerInboxCodexSqliteRouting(record())).toBe(false)
  })

  it('refuses a config symlink or other non-regular input before reading', () => {
    vi.mocked(lstatSync).mockReturnValue({ isFile: () => false } as Stats)
    expect(admitsPeerInboxCodexSqliteRouting(record())).toBe(false)
    expect(readNodeFileSyncWithinLimit).not.toHaveBeenCalled()
  })

  it('refuses oversized or unreadable contents', () => {
    config('')
    vi.mocked(readNodeFileSyncWithinLimit).mockImplementation(() => {
      throw new Error('too large')
    })
    expect(admitsPeerInboxCodexSqliteRouting(record())).toBe(false)
  })

  it('erases configuration bytes after inspecting them', () => {
    const buffer = Buffer.from('model = "codex"')
    config('')
    vi.mocked(readNodeFileSyncWithinLimit).mockReturnValue({ buffer, stats: {} as Stats })
    expect(admitsPeerInboxCodexSqliteRouting(record())).toBe(true)
    expect(buffer.every((value) => value === 0)).toBe(true)
  })
})
