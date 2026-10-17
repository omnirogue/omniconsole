import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeClaudeProjectPath } from '../ai-vault/claude-project-dir-encoding'
import {
  claudeThreadMemoryFlags,
  createClaudeThreadMemory,
  restoreClaudeThreadMemorySettings
} from './claude-thread-memory'

const owner = { projectFolderId: 'project-1', dispatchId: 'dispatch-1' }
const repoPath = '/work/omni-ide'

describe('claude thread memory', () => {
  let base: string
  let root: string
  let configDir: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'claude-thread-memory-'))
    root = join(base, 'claude-thread-memory')
    configDir = join(base, '.claude')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(base, { recursive: true, force: true })
  })

  function sharedMemory(): string {
    const dir = join(configDir, 'projects', encodeClaudeProjectPath(repoPath), 'memory')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), '- [Release path](release.md)\n')
    return dir
  }

  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

  it("points a new thread's memory at the repo's shared index and grants reading it", () => {
    const shared = sharedMemory()

    const { key, settingsPath } = createClaudeThreadMemory({ owner, repoPath, configDir, root })

    const dir = join(root, key)
    expect(settingsPath).toBe(join(dir, 'settings.json'))
    expect(read(settingsPath)).toEqual({
      autoMemoryDirectory: join(dir, 'memory'),
      permissions: { additionalDirectories: [shared] }
    })
    expect(readFileSync(join(dir, 'memory', 'MEMORY.md'), 'utf8')).toContain(
      `(<${join(shared, 'MEMORY.md')}>)`
    )
    expect(read(join(dir, 'thread.json'))).toMatchObject({ ...owner, repoMemoryDir: shared })
  })

  it('starts empty with no grant when the repo has no shared memory yet', () => {
    const { key, settingsPath } = createClaudeThreadMemory({ owner, repoPath, configDir, root })

    expect(read(settingsPath)).toEqual({ autoMemoryDirectory: join(root, key, 'memory') })
    expect(existsSync(join(root, key, 'memory', 'MEMORY.md'))).toBe(false)
  })

  it('gives each thread its own folder', () => {
    const first = createClaudeThreadMemory({ owner, repoPath, configDir, root })
    const second = createClaudeThreadMemory({ owner, repoPath, configDir, root })

    expect(first.key).not.toBe(second.key)
    expect(first.key).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('adds the flag only to a local Claude launch in a project', () => {
    const base = { owner, agent: 'claude', local: true, repoPath, configDir, root }

    expect(claudeThreadMemoryFlags(base)).toEqual([
      ['--settings', expect.stringMatching(/settings\.json$/)]
    ])
    expect(claudeThreadMemoryFlags({ ...base, owner: undefined })).toBeUndefined()
    expect(claudeThreadMemoryFlags({ ...base, agent: 'codex' })).toBeUndefined()
    expect(claudeThreadMemoryFlags({ ...base, local: false })).toBeUndefined()
  })

  it('falls back to the shared memory when the folder cannot be created', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(root, 'not a folder')

    expect(
      claudeThreadMemoryFlags({ owner, agent: 'claude', local: true, repoPath, configDir, root })
    ).toBeUndefined()
  })

  it('re-creates a missing settings file named by a saved launch command', () => {
    const shared = sharedMemory()
    const { settingsPath } = createClaudeThreadMemory({ owner, repoPath, configDir, root })
    const before = read(settingsPath)
    rmSync(settingsPath)

    restoreClaudeThreadMemorySettings(`claude --settings '${settingsPath}' --resume abc`, root)

    expect(read(settingsPath)).toEqual(before)
    expect(before.permissions.additionalDirectories).toEqual([shared])
  })

  it('leaves commands that name no thread settings file under this root alone', () => {
    const elsewhere = join(base, 'other', 'claude-thread-memory', crypto.randomUUID())

    restoreClaudeThreadMemorySettings(`claude --settings ${elsewhere}/settings.json`, root)
    restoreClaudeThreadMemorySettings('claude --resume abc', root)
    restoreClaudeThreadMemorySettings(undefined, root)

    expect(existsSync(root)).toBe(false)
    expect(existsSync(elsewhere)).toBe(false)
  })
})
