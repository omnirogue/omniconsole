import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureClaudeHooksForRequestedEnv,
  resetEnsuredClaudeHookDirectoriesForTests
} from './account-directory-hooks'

describe('ensureClaudeHooksForRequestedEnv', () => {
  beforeEach(() => {
    resetEnsuredClaudeHookDirectoriesForTests()
  })

  it('mirrors the managed hooks into a named config directory once per process', () => {
    const install = vi.fn().mockReturnValue({ state: 'installed', detail: null })
    const deps = { defaultProfileHasHooks: () => true, install }
    ensureClaudeHooksForRequestedEnv({ CLAUDE_CONFIG_DIR: '/pool/slot-2' }, deps)
    ensureClaudeHooksForRequestedEnv({ CLAUDE_CONFIG_DIR: '/pool/slot-2' }, deps)
    ensureClaudeHooksForRequestedEnv({ CLAUDE_CONFIG_DIR: '/pool/slot-3' }, deps)
    expect(install.mock.calls).toEqual([['/pool/slot-2'], ['/pool/slot-3']])
  })

  it('does nothing without a config directory or when the person keeps no hooks', () => {
    const install = vi.fn()
    ensureClaudeHooksForRequestedEnv(undefined, { defaultProfileHasHooks: () => true, install })
    ensureClaudeHooksForRequestedEnv(
      { PATH: '/usr/bin' },
      { defaultProfileHasHooks: () => true, install }
    )
    ensureClaudeHooksForRequestedEnv(
      { CLAUDE_CONFIG_DIR: '/pool/slot-4' },
      { defaultProfileHasHooks: () => false, install }
    )
    expect(install).not.toHaveBeenCalled()
  })

  it('never lets a hook install failure break the spawn', () => {
    const install = vi.fn(() => {
      throw new Error('disk full')
    })
    expect(() =>
      ensureClaudeHooksForRequestedEnv(
        { CLAUDE_CONFIG_DIR: '/pool/slot-5' },
        { defaultProfileHasHooks: () => true, install }
      )
    ).not.toThrow()
  })
})
