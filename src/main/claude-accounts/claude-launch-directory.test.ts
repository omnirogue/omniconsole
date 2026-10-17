import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  carry: vi.fn(),
  diffPanel: vi.fn(),
  hooks: vi.fn(),
  token: vi.fn()
}))
vi.mock('../agent-trust-presets', () => ({ carryClaudeProjectTrust: mocks.carry }))
vi.mock('./claude-diff-panel-preference', () => ({ keepClaudeDiffPanelClosed: mocks.diffPanel }))
vi.mock('./account-directory-hooks', () => ({ ensureClaudeHooksForRequestedEnv: mocks.hooks }))
vi.mock('./setup-token-directory', () => ({ applyClaudeSetupTokenDirectory: mocks.token }))

import { prepareClaudeLaunchDirectory } from './claude-launch-directory'

const auth = {
  configDir: '/accounts/slot-2/session',
  envPatch: { CLAUDE_CONFIG_DIR: '/accounts/slot-2/session' },
  stripAuthEnv: true,
  provenance: 'managed:slot-2'
}

beforeEach(() => vi.clearAllMocks())

describe('prepareClaudeLaunchDirectory', () => {
  it('carries the recorded folder trust into the directory account preparation chose', () => {
    const env = { CLAUDE_CONFIG_DIR: auth.configDir }
    const requested = { CLAUDE_CONFIG_DIR: '/profile' }
    prepareClaudeLaunchDirectory(env, requested, { cwd: '/repo/wt', claudeAuth: auth })
    expect(mocks.token).toHaveBeenCalledWith(env, requested)
    expect(mocks.hooks).toHaveBeenCalledWith(requested)
    expect(mocks.carry).toHaveBeenCalledWith('/repo/wt', auth.configDir, '/profile')
    expect(mocks.diffPanel).toHaveBeenCalledWith(
      auth.configDir,
      expect.objectContaining({ CLAUDE_CONFIG_DIR: auth.configDir })
    )
  })

  it('leaves trust alone for a spawn that is not Claude, or runs inside WSL', () => {
    prepareClaudeLaunchDirectory({}, undefined, { cwd: '/repo/wt', claudeAuth: null })
    prepareClaudeLaunchDirectory({}, undefined, {
      cwd: '/repo/wt',
      claudeAuth: { ...auth, runtime: 'wsl' }
    })
    expect(mocks.carry).not.toHaveBeenCalled()
    expect(mocks.diffPanel).not.toHaveBeenCalled()
    expect(mocks.token).toHaveBeenCalledTimes(2)
  })

  it('never fails a spawn over the trust copy or the diff pane preference', () => {
    mocks.carry.mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    mocks.diffPanel.mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    expect(() =>
      prepareClaudeLaunchDirectory({}, undefined, { cwd: '/repo/wt', claudeAuth: auth })
    ).not.toThrow()
  })
})
