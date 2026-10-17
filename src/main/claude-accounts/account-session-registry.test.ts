import {
  existsSync,
  lstatSync,
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
import { shareDefaultSessionRegistry } from './account-session-registry'

const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.restoreAllMocks()
})

function account(records: string[] | null) {
  const root = mkdtempSync(join(tmpdir(), 'claude-session-registry-'))
  roots.push(root)
  const shared = join(root, 'default', 'sessions')
  const configDir = join(root, 'account', 'session')
  mkdirSync(shared, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  const registry = join(configDir, 'sessions')
  if (records) {
    mkdirSync(registry)
    records.forEach((name) => writeFileSync(join(registry, name), `old ${name}`))
  }
  return { root, shared, configDir, registry }
}

const exited = (): boolean => false
const key = (pid: number): string => `${pid}.${'a'.repeat(64)}.key`
const linkType = process.platform === 'win32' ? 'junction' : 'dir'
const leftovers = (configDir: string): string[] =>
  readdirSync(configDir).filter((name) => name !== 'sessions')

describe('shareDefaultSessionRegistry', () => {
  it('links a new account to the default registry', () => {
    const { shared, configDir, registry } = account(null)
    shareDefaultSessionRegistry(configDir, { defaultRegistry: shared, alive: exited })
    expect(realpathSync(registry)).toBe(realpathSync(shared))
  })

  it('moves running sessions into the default registry and drops exited ones', () => {
    const { shared, configDir, registry } = account(['101.json', key(101), '202.json', key(202)])
    shareDefaultSessionRegistry(configDir, { defaultRegistry: shared, alive: (pid) => pid === 202 })
    expect(realpathSync(registry)).toBe(realpathSync(shared))
    expect(readdirSync(shared).sort()).toEqual(['202.json', key(202)].sort())
    expect(readFileSync(join(shared, '202.json'), 'utf8')).toBe('old 202.json')
    expect(leftovers(configDir)).toEqual([])
  })

  it('keeps a copy the session already wrote into the default registry', () => {
    const { shared, configDir } = account(['202.json'])
    writeFileSync(join(shared, '202.json'), 'newer')
    shareDefaultSessionRegistry(configDir, { defaultRegistry: shared, alive: () => true })
    expect(readFileSync(join(shared, '202.json'), 'utf8')).toBe('newer')
  })

  it('keeps a registry that holds anything besides Claude records', () => {
    const { shared, configDir, registry } = account(['101.json', 'notes.txt'])
    shareDefaultSessionRegistry(configDir, { defaultRegistry: shared, alive: exited })
    expect(lstatSync(registry).isDirectory()).toBe(true)
    expect(readdirSync(registry).sort()).toEqual(['101.json', 'notes.txt'])
  })

  it('leaves an existing link alone', () => {
    const { root, shared, configDir, registry } = account(null)
    const other = join(root, 'other')
    mkdirSync(other)
    symlinkSync(other, registry, linkType)
    shareDefaultSessionRegistry(configDir, { defaultRegistry: shared, alive: exited })
    expect(realpathSync(registry)).toBe(realpathSync(other))
  })

  it('does nothing when there is no default registry', () => {
    const { root, configDir, registry } = account(null)
    shareDefaultSessionRegistry(configDir, {
      defaultRegistry: join(root, 'missing'),
      alive: exited
    })
    expect(existsSync(registry)).toBe(false)
  })

  it('puts the registry back when the link cannot be made', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { shared, configDir, registry } = account(['202.json', key(202)])
    const symlink = (): void => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    }
    shareDefaultSessionRegistry(configDir, { defaultRegistry: shared, alive: () => true, symlink })
    expect(lstatSync(registry).isDirectory()).toBe(true)
    expect(readdirSync(registry).sort()).toEqual(['202.json', key(202)].sort())
    expect(leftovers(configDir)).toEqual([])
  })

  it('merges into a registry a starting session recreated during the swap', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { shared, configDir, registry } = account(['202.json'])
    const symlink = (): void => {
      mkdirSync(registry)
      writeFileSync(join(registry, '303.json'), 'new session')
      throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    }
    shareDefaultSessionRegistry(configDir, { defaultRegistry: shared, alive: () => true, symlink })
    expect(readdirSync(registry).sort()).toEqual(['202.json', '303.json'])
    expect(readFileSync(join(registry, '303.json'), 'utf8')).toBe('new session')
    expect(leftovers(configDir)).toEqual([])
  })
})
