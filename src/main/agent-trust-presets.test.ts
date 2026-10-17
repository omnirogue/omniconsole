import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = {
  fakeHomeDir: '',
  userDataDir: '',
  previousUserDataPath: undefined as string | undefined
}

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') {
        return testState.userDataDir
      }
      throw new Error(`unexpected app.getPath(${name})`)
    }
  }
}))

vi.mock('node:os', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

const {
  carryClaudeProjectTrust,
  markClaudeProjectTrusted,
  markCodexProjectTrusted,
  markCopilotFolderTrusted,
  markCursorWorkspaceTrusted
} = await import('./agent-trust-presets')
const { runExclusivelyForCodexTrustConfig } =
  await import('./codex/codex-trust-config-mutation-queue')

beforeEach(() => {
  testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'omni-trust-presets-'))
  testState.userDataDir = mkdtempSync(join(tmpdir(), 'omni-trust-presets-user-data-'))
  testState.previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = testState.userDataDir
})

afterEach(() => {
  rmSync(testState.fakeHomeDir, { recursive: true, force: true })
  rmSync(testState.userDataDir, { recursive: true, force: true })
  if (testState.previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = testState.previousUserDataPath
  }
  testState.fakeHomeDir = ''
  testState.userDataDir = ''
  testState.previousUserDataPath = undefined
})

describe('markCursorWorkspaceTrusted', () => {
  it('writes ~/.cursor/projects/<slug>/.workspace-trusted with the cwd payload', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'omni-cursor-ws-'))
    try {
      markCursorWorkspaceTrusted(workspace)
      const projectsDir = join(testState.fakeHomeDir, '.cursor', 'projects')
      const slugDirs = readdirSync(projectsDir)
      expect(slugDirs.length).toBe(1)
      const trustFile = join(projectsDir, slugDirs[0], '.workspace-trusted')
      expect(existsSync(trustFile)).toBe(true)
      const payload = JSON.parse(readFileSync(trustFile, 'utf-8'))
      expect(payload.workspacePath).toBeTruthy()
      expect(typeof payload.trustedAt).toBe('string')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('is idempotent — re-marking the same workspace does not overwrite trustedAt', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'omni-cursor-ws-'))
    try {
      markCursorWorkspaceTrusted(workspace)
      const projectsDir = join(testState.fakeHomeDir, '.cursor', 'projects')
      const slugDirs = readdirSync(projectsDir)
      const trustFile = join(projectsDir, slugDirs[0], '.workspace-trusted')
      const firstPayload = readFileSync(trustFile, 'utf-8')
      markCursorWorkspaceTrusted(workspace)
      const secondPayload = readFileSync(trustFile, 'utf-8')
      expect(secondPayload).toBe(firstPayload)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('markCopilotFolderTrusted', () => {
  it('appends the workspace to trustedFolders in ~/.copilot/config.json', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'omni-copilot-ws-'))
    try {
      markCopilotFolderTrusted(workspace)
      const configPath = join(testState.fakeHomeDir, '.copilot', 'config.json')
      expect(existsSync(configPath)).toBe(true)
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(Array.isArray(parsed.trustedFolders)).toBe(true)
      expect(parsed.trustedFolders.length).toBe(1)
      expect(typeof parsed.trustedFolders[0]).toBe('string')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('preserves existing config keys and dedups already-trusted folders', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'omni-copilot-ws-'))
    const realpath = realpathSync(workspace)
    try {
      mkdirSync(join(testState.fakeHomeDir, '.copilot'), { recursive: true })
      writeFileSync(
        join(testState.fakeHomeDir, '.copilot', 'config.json'),
        JSON.stringify({
          firstLaunchAt: '2026-01-01T00:00:00.000Z',
          trustedFolders: [realpath]
        })
      )
      markCopilotFolderTrusted(workspace)
      const parsed = JSON.parse(
        readFileSync(join(testState.fakeHomeDir, '.copilot', 'config.json'), 'utf-8')
      )
      expect(parsed.firstLaunchAt).toBe('2026-01-01T00:00:00.000Z')
      expect(parsed.trustedFolders).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('markClaudeProjectTrusted', () => {
  it('marks the project trusted in the default profile and keeps the rest of .claude.json', () => {
    const configPath = join(testState.fakeHomeDir, '.claude.json')
    writeFileSync(
      configPath,
      JSON.stringify({ theme: 'dark', projects: { '/elsewhere': { allowedTools: ['Bash'] } } })
    )
    const workspace = join(testState.fakeHomeDir, 'repo')
    mkdirSync(workspace, { recursive: true })

    markClaudeProjectTrusted(workspace)

    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.theme).toBe('dark')
    expect(written.projects['/elsewhere']).toEqual({ allowedTools: ['Bash'] })
    expect(written.projects[realpathSync.native(workspace)]).toMatchObject({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true
    })
    const before = readFileSync(configPath, 'utf-8')
    markClaudeProjectTrusted(workspace)
    expect(readFileSync(configPath, 'utf-8')).toBe(before)
  })

  it('writes into the launch account directory when one is named, creating the file', () => {
    const accountDir = join(testState.fakeHomeDir, 'accounts', 'slot-2')
    mkdirSync(accountDir, { recursive: true })
    const workspace = join(testState.fakeHomeDir, 'child-worktree')
    mkdirSync(workspace, { recursive: true })

    markClaudeProjectTrusted(workspace, accountDir)

    const written = JSON.parse(readFileSync(join(accountDir, '.claude.json'), 'utf-8'))
    expect(written.projects[realpathSync.native(workspace)].hasTrustDialogAccepted).toBe(true)
    expect(existsSync(join(testState.fakeHomeDir, '.claude.json'))).toBe(false)
  })

  it('refuses to overwrite an unreadable .claude.json', () => {
    const configPath = join(testState.fakeHomeDir, '.claude.json')
    writeFileSync(configPath, '{ not json')
    markClaudeProjectTrusted(join(testState.fakeHomeDir, 'repo'))
    expect(readFileSync(configPath, 'utf-8')).toBe('{ not json')
  })
})

describe('carryClaudeProjectTrust', () => {
  function trusts(configDir: string, workspace: string): boolean {
    const config = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf-8'))
    return config.projects?.[realpathSync.native(workspace)]?.hasTrustDialogAccepted === true
  }

  it('carries the trust a launch recorded into the account directory the spawn chose', () => {
    const workspace = join(testState.fakeHomeDir, 'child-worktree')
    mkdirSync(workspace, { recursive: true })
    const accountDir = join(testState.fakeHomeDir, 'accounts', 'slot-2', 'session')
    mkdirSync(accountDir, { recursive: true })
    writeFileSync(join(accountDir, '.claude.json'), JSON.stringify({ theme: 'dark' }))
    markClaudeProjectTrusted(workspace)

    carryClaudeProjectTrust(workspace, accountDir)

    expect(trusts(accountDir, workspace)).toBe(true)
    expect(JSON.parse(readFileSync(join(accountDir, '.claude.json'), 'utf-8')).theme).toBe('dark')
  })

  it('carries trust recorded in the directory the launch asked for', () => {
    const workspace = join(testState.fakeHomeDir, 'child-worktree')
    mkdirSync(workspace, { recursive: true })
    const requested = join(testState.fakeHomeDir, 'profile')
    const chosen = join(testState.fakeHomeDir, 'profile', 'session')
    mkdirSync(chosen, { recursive: true })
    writeFileSync(join(chosen, '.claude.json'), '{}')
    markClaudeProjectTrusted(workspace, requested)

    carryClaudeProjectTrust(workspace, chosen, requested)

    expect(trusts(chosen, workspace)).toBe(true)
  })

  it('trusts nothing new, and creates no config file', () => {
    const workspace = join(testState.fakeHomeDir, 'untrusted')
    mkdirSync(workspace, { recursive: true })
    const accountDir = join(testState.fakeHomeDir, 'accounts', 'slot-3')
    mkdirSync(accountDir, { recursive: true })
    writeFileSync(join(accountDir, '.claude.json'), '{}')
    carryClaudeProjectTrust(workspace, accountDir)
    expect(trusts(accountDir, workspace)).toBe(false)

    const fresh = join(testState.fakeHomeDir, 'accounts', 'slot-4')
    markClaudeProjectTrusted(workspace)
    carryClaudeProjectTrust(workspace, fresh)
    expect(existsSync(join(fresh, '.claude.json'))).toBe(false)
    carryClaudeProjectTrust(undefined, accountDir)
    carryClaudeProjectTrust(workspace, undefined)
  })
})

describe('markCodexProjectTrusted', () => {
  it('trusts the launch account home while preserving its config and the shared runtime home', async () => {
    const workspace = join(testState.fakeHomeDir, 'folder-workspace')
    const accountHome = join(testState.fakeHomeDir, 'accounts', 'slot-2')
    const accountConfigPath = join(accountHome, 'config.toml')
    const runtimeHome = join(testState.userDataDir, 'codex-runtime-home', 'home')
    const runtimeConfigPath = join(runtimeHome, 'config.toml')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(accountHome, { recursive: true })
    mkdirSync(runtimeHome, { recursive: true })
    const projectHeader = `[projects."${escapeTomlBasicString(realpathSync.native(workspace))}"]`
    writeFileSync(
      accountConfigPath,
      ['model = "gpt-5.5"', '', projectHeader, 'notes = "keep"', 'trust_level = "untrusted"'].join(
        '\n'
      )
    )
    const runtimeConfig = 'sandbox_mode = "workspace-write"\n'
    writeFileSync(runtimeConfigPath, runtimeConfig)

    await markCodexProjectTrusted(workspace, accountHome)

    const written = readFileSync(accountConfigPath, 'utf-8')
    expect(written).toContain(projectHeader)
    expect(written).toContain('model = "gpt-5.5"')
    expect(written).toContain('notes = "keep"')
    expect(written).toContain('trust_level = "trusted"')
    expect(written).not.toContain('trust_level = "untrusted"')
    expect(readFileSync(runtimeConfigPath, 'utf-8')).toBe(runtimeConfig)
    expect(readFileSync(join(testState.fakeHomeDir, '.codex', 'config.toml'), 'utf-8')).toContain(
      projectHeader
    )
    await markCodexProjectTrusted(workspace, accountHome)
    expect(readFileSync(accountConfigPath, 'utf-8')).toBe(written)
  })

  it('queues behind a trust mutation in the selected account home', async () => {
    const workspace = join(testState.fakeHomeDir, 'folder-workspace')
    const accountHome = join(testState.fakeHomeDir, 'accounts', 'slot-2')
    const configPath = join(accountHome, 'config.toml')
    let releaseGrant!: () => void
    const grantHoldingTheFile = new Promise<void>((resolve) => {
      releaseGrant = resolve
    })
    const held = runExclusivelyForCodexTrustConfig(configPath, async () => {
      await grantHoldingTheFile
      mkdirSync(accountHome, { recursive: true })
      writeFileSync(configPath, 'sandbox_mode = "workspace-write"\n')
    })
    let completed = false
    const marked = markCodexProjectTrusted(workspace, accountHome).then(() => {
      completed = true
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(completed).toBe(false)
      expect(existsSync(configPath)).toBe(false)
    } finally {
      releaseGrant()
      await held
      await marked
    }
    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain('sandbox_mode = "workspace-write"')
    expect(written).toContain('trust_level = "trusted"')
  })

  it('supports an account home that is also the system home without duplicating trust', async () => {
    const workspace = join(testState.fakeHomeDir, 'folder-workspace')
    const accountHome = join(testState.fakeHomeDir, '.codex')

    await markCodexProjectTrusted(workspace, accountHome)

    const written = readFileSync(join(accountHome, 'config.toml'), 'utf-8')
    expect(written.match(/trust_level = "trusted"/g)).toHaveLength(1)
    expect(existsSync(join(testState.userDataDir, 'codex-runtime-home', 'home'))).toBe(false)
  })

  // Why (#16441): a hook install/grant holds this file across an awaited
  // app-server session; an unqueued write here lands inside its
  // capture->restore window and is silently reverted.
  it('queues behind an in-flight Codex trust-config mutation', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'omni-codex-ws-'))
    const configPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    let releaseGrant!: () => void
    const grantHoldingTheFile = new Promise<void>((resolve) => {
      releaseGrant = resolve
    })
    try {
      const held = runExclusivelyForCodexTrustConfig(configPath, () => grantHoldingTheFile)
      const marked = markCodexProjectTrusted(workspace)
      await Promise.resolve()
      expect(existsSync(configPath)).toBe(false)

      releaseGrant()
      await held
      await marked
      expect(readFileSync(configPath, 'utf-8')).toContain('trust_level = "trusted"')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('trusts the main repository root for a linked worktree without reading commondir', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'omni-codex-linked-ws-'))
    const repository = join(fixtureRoot, 'repo')
    const workspace = join(fixtureRoot, 'worktrees', 'feature')
    const worktreeGitDir = join(repository, '.git', 'worktrees', 'feature')
    try {
      mkdirSync(worktreeGitDir, { recursive: true })
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf-8')
      writeFileSync(join(worktreeGitDir, 'gitdir'), join(workspace, '.git'), 'utf-8')

      await markCodexProjectTrusted(workspace)

      const repositoryRoot = realpathSync.native(repository)
      const workspaceRoot = realpathSync.native(workspace)
      const configPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
      const runtimeConfigPath = join(
        testState.userDataDir,
        'codex-runtime-home',
        'home',
        'config.toml'
      )
      for (const written of [
        readFileSync(configPath, 'utf-8'),
        readFileSync(runtimeConfigPath, 'utf-8')
      ]) {
        expect(written).toContain(`[projects."${escapeTomlBasicString(repositoryRoot)}"]`)
        expect(written).not.toContain(`[projects."${escapeTomlBasicString(workspaceRoot)}"]`)
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('does not broaden trust through arbitrary or adversarial Git metadata', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'omni-codex-untrusted-gitdir-'))
    const workspace = join(fixtureRoot, 'workspace')
    const arbitraryGitDir = join(fixtureRoot, 'metadata', 'feature')
    const unrelatedRoot = join(fixtureRoot, 'unrelated')
    try {
      mkdirSync(arbitraryGitDir, { recursive: true })
      mkdirSync(workspace, { recursive: true })
      mkdirSync(unrelatedRoot, { recursive: true })
      writeFileSync(join(workspace, '.git'), `gitdir: ${arbitraryGitDir}\n`, 'utf-8')
      writeFileSync(join(arbitraryGitDir, 'commondir'), join(unrelatedRoot, '.git'), 'utf-8')

      await markCodexProjectTrusted(workspace)
      const structuredGitDir = join(unrelatedRoot, '.git', 'worktrees', 'feature')
      mkdirSync(structuredGitDir, { recursive: true })
      writeFileSync(join(workspace, '.git'), `gitdir: ${structuredGitDir}\n`, 'utf-8')
      writeFileSync(join(structuredGitDir, 'gitdir'), join(unrelatedRoot, '.git'), 'utf-8')
      await markCodexProjectTrusted(workspace)

      const written = readFileSync(join(testState.fakeHomeDir, '.codex', 'config.toml'), 'utf-8')
      expect(written).toContain(
        `[projects."${escapeTomlBasicString(realpathSync.native(workspace))}"]`
      )
      expect(written).not.toContain(
        `[projects."${escapeTomlBasicString(realpathSync.native(unrelatedRoot))}"]`
      )
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('writes ~/.codex/config.toml with the project marked trusted', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'omni-codex-ws-'))
    try {
      const realpath = realpathSync.native(workspace)
      await markCodexProjectTrusted(workspace)
      const configPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
      const runtimeConfigPath = join(
        testState.userDataDir,
        'codex-runtime-home',
        'home',
        'config.toml'
      )
      expect(existsSync(configPath)).toBe(true)
      expect(existsSync(runtimeConfigPath)).toBe(true)
      const written = readFileSync(configPath, 'utf-8')
      const runtimeWritten = readFileSync(runtimeConfigPath, 'utf-8')
      expect(written).toContain(`[projects."${escapeTomlBasicString(realpath)}"]`)
      expect(written).toContain('trust_level = "trusted"')
      expect(runtimeWritten).toContain(`[projects."${escapeTomlBasicString(realpath)}"]`)
      expect(runtimeWritten).toContain('trust_level = "trusted"')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('preserves existing config keys and updates an existing project block', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'omni-codex-ws-'))
    const realpath = realpathSync.native(workspace)
    try {
      const codexDir = join(testState.fakeHomeDir, '.codex')
      const runtimeCodexDir = join(testState.userDataDir, 'codex-runtime-home', 'home')
      mkdirSync(codexDir, { recursive: true })
      mkdirSync(runtimeCodexDir, { recursive: true })
      writeFileSync(
        join(codexDir, 'config.toml'),
        [
          'model = "gpt-5.5"',
          '',
          `[projects."${escapeTomlBasicString(realpath)}"]`,
          'notes = "keep"',
          'trust_level = "untrusted"',
          ''
        ].join('\n'),
        'utf-8'
      )
      writeFileSync(
        join(runtimeCodexDir, 'config.toml'),
        [
          'sandbox_mode = "workspace-write"',
          '',
          `[projects."${escapeTomlBasicString(realpath)}"]`,
          'notes = "keep-runtime"',
          'trust_level = "untrusted"',
          ''
        ].join('\n'),
        'utf-8'
      )

      await markCodexProjectTrusted(workspace)

      const written = readFileSync(join(codexDir, 'config.toml'), 'utf-8')
      const runtimeWritten = readFileSync(join(runtimeCodexDir, 'config.toml'), 'utf-8')
      expect(written).toContain('model = "gpt-5.5"')
      expect(written).toContain('notes = "keep"')
      expect(written).toContain('trust_level = "trusted"')
      expect(written).not.toContain('trust_level = "untrusted"')
      expect(runtimeWritten).toContain('sandbox_mode = "workspace-write"')
      expect(runtimeWritten).toContain('notes = "keep-runtime"')
      expect(runtimeWritten).toContain('trust_level = "trusted"')
      expect(runtimeWritten).not.toContain('trust_level = "untrusted"')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

function escapeTomlBasicString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}
