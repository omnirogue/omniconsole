// Compat gate for the host half of an account launch: the managed status hooks are
// mirrored into the launch's CLAUDE_CONFIG_DIR while the spawn environment is still
// being assembled — before the PTY exists, so before any prompt can be delivered.
// Without the mirror no status ever arrives and every prompt reads as stalled.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mirror = vi.hoisted(() => ({ ensureClaudeHooksForRequestedEnv: vi.fn() }))
const history = vi.hoisted(() => ({
  injectHistoryEnv: vi.fn(() => null),
  injectWslFishHistoryEnv: vi.fn(),
  logHistoryInjection: vi.fn()
}))

vi.mock('../claude-accounts/account-directory-hooks', () => mirror)
vi.mock('../terminal-history', () => history)
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/omni-user-data' } }))

import { finalizeLocalPtySpawnEnvironment } from './local-pty-finalize-environment'

type FinalizeArgs = Parameters<typeof finalizeLocalPtySpawnEnvironment>[0]

function finalize(requestedEnv: Record<string, string> | undefined): void {
  finalizeLocalPtySpawnEnvironment({
    spawn: { env: requestedEnv, cwd: '/Users/me/Webinar' },
    getOptions: () => ({ isHistoryEnabled: () => false }),
    plan: { shellPath: '/bin/zsh', cwd: '/Users/me/Webinar', shellArgs: [] },
    env: { PATH: '/usr/bin', ...requestedEnv }
  } as unknown as FinalizeArgs)
}

describe('mirroring managed hooks for an account launch', () => {
  beforeEach(() => {
    mirror.ensureClaudeHooksForRequestedEnv.mockClear()
  })

  it('mirrors into the config directory the launch asked for, from the env assembly', () => {
    finalize({ CLAUDE_CONFIG_DIR: '/pool/slot-3' })
    expect(mirror.ensureClaudeHooksForRequestedEnv).toHaveBeenCalledWith({
      CLAUDE_CONFIG_DIR: '/pool/slot-3'
    })
  })

  it('still runs the mirror decision for a launch with no account env', () => {
    // The mirror itself short-circuits without a config directory; the call must stay on
    // the path so an account launch can never bypass it.
    finalize(undefined)
    expect(mirror.ensureClaudeHooksForRequestedEnv).toHaveBeenCalledWith(undefined)
  })
})
