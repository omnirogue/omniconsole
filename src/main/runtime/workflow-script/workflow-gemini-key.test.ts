import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WORKFLOW_GEMINI_KEY_MISSING,
  WORKFLOW_GEMINI_KEY_MISSING_WINDOWS,
  workflowGeminiApiKey,
  workflowGeminiKeyLookup
} from './workflow-gemini-key'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workflow-gemini-key-'))
  directories.push(root)
  const home = join(root, '.gemini')
  mkdirSync(home)
  const vault = join(root, 'vault.env')
  return { home, vault }
}

describe.skipIf(process.platform === 'win32')('the Gemini key a workflow seat runs with', () => {
  it('takes the environment first, then the account .env, then the private vault', () => {
    const f = fixture()
    writeFileSync(f.vault, 'OTHER=1\nexport GEMINI_API_KEY="vault-key"\n', { mode: 0o600 })
    expect(workflowGeminiApiKey(f.home, {}, f.vault)).toBe('vault-key')
    writeFileSync(join(f.home, '.env'), 'GEMINI_API_KEY=account-key\n')
    expect(workflowGeminiApiKey(f.home, {}, f.vault)).toBe('account-key')
    expect(workflowGeminiApiKey(f.home, { GEMINI_API_KEY: ' env-key ' }, f.vault)).toBe('env-key')
  })

  it('never reads a vault other users can read, and says why', () => {
    const f = fixture()
    writeFileSync(f.vault, 'GEMINI_API_KEY=vault-key\n')
    chmodSync(f.vault, 0o644)
    expect(workflowGeminiApiKey(f.home, {}, f.vault)).toBeUndefined()
    expect(workflowGeminiKeyLookup(f.home, {}, f.vault)).toEqual({
      missing:
        'Gemini needs GEMINI_API_KEY in the environment or ~/.gemini/.env; ~/.config/omni/connections.env is not private to you (it should be yours, mode 600), so it is not read.'
    })
  })

  it('never follows a symbolic link to a private file, nor reads a directory or a huge file', () => {
    const f = fixture()
    const target = join(f.home, 'elsewhere.env')
    writeFileSync(target, 'GEMINI_API_KEY=linked-key\n', { mode: 0o600 })
    symlinkSync(target, f.vault)
    expect(workflowGeminiKeyLookup(f.home, {}, f.vault)).toEqual({
      missing: expect.stringContaining('connections.env is a symbolic link, so it is not read')
    })
    const directory = join(f.home, 'vault-dir')
    mkdirSync(directory, { mode: 0o700 })
    expect(workflowGeminiKeyLookup(f.home, {}, directory)).toEqual({
      missing: expect.stringContaining('is not a regular file under 1 MB')
    })
    const locked = join(f.home, 'locked.env')
    writeFileSync(locked, 'GEMINI_API_KEY=locked-key\n', { mode: 0o000 })
    if (process.getuid?.() !== 0) {
      expect(workflowGeminiKeyLookup(f.home, {}, locked)).toEqual({
        missing: expect.stringContaining('connections.env cannot be opened (EACCES)')
      })
    }
    const huge = join(f.home, 'huge.env')
    writeFileSync(huge, `GEMINI_API_KEY=big\n${'#'.repeat(1024 * 1024)}`, { mode: 0o600 })
    expect(workflowGeminiApiKey(f.home, {}, huge)).toBeUndefined()
  })

  it('does not read the vault on Windows, where its privacy cannot be shown', () => {
    const f = fixture()
    writeFileSync(f.vault, 'GEMINI_API_KEY=vault-key\n', { mode: 0o600 })
    expect(workflowGeminiKeyLookup(f.home, {}, f.vault, 'win32')).toEqual({
      missing: WORKFLOW_GEMINI_KEY_MISSING_WINDOWS
    })
    writeFileSync(join(f.home, '.env'), 'GEMINI_API_KEY=account-key\n')
    expect(workflowGeminiApiKey(f.home, {}, f.vault, 'win32')).toBe('account-key')
  })

  it('has no key when none is set anywhere', () => {
    const f = fixture()
    expect(workflowGeminiKeyLookup(f.home, {}, f.vault)).toEqual({
      missing: WORKFLOW_GEMINI_KEY_MISSING
    })
  })
})
