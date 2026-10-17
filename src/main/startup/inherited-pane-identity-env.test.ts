import { describe, expect, it } from 'vitest'
import { clearInheritedPaneIdentityEnv } from './inherited-pane-identity-env'

describe('clearInheritedPaneIdentityEnv', () => {
  it('drops the identity of the pane the app was relaunched from', () => {
    const env: NodeJS.ProcessEnv = {
      HOME: '/Users/tester',
      PATH: '/usr/bin',
      ORCA_APP_VERSION: '1.12.11',
      ORCA_USER_DATA_PATH: '/data',
      ORCA_PANE_KEY: 'tab:leaf',
      ORCA_TAB_ID: 'tab',
      ORCA_WORKTREE_ID: 'wt::/repo',
      ORCA_WORKSPACE_ID: 'wt::/repo',
      ORCA_TERMINAL_HANDLE: 'term_1',
      ORCA_AGENT_LAUNCH_TOKEN: 'launch',
      ORCA_AGENT_HOOK_PORT: '50074',
      ORCA_AGENT_HOOK_TOKEN: 'token',
      ORCA_AGENT_HOOK_ENDPOINT: '/data/agent-hooks/endpoint.env',
      ORCA_AGENT_HOOK_TRANSPORT: 'raw-json-v1'
    }

    expect(clearInheritedPaneIdentityEnv(env)).toHaveLength(10)
    expect(env).toEqual({
      HOME: '/Users/tester',
      PATH: '/usr/bin',
      ORCA_APP_VERSION: '1.12.11',
      ORCA_USER_DATA_PATH: '/data'
    })
  })

  it('leaves a Finder-launched environment alone', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/Users/tester' }
    expect(clearInheritedPaneIdentityEnv(env)).toEqual([])
    expect(env).toEqual({ HOME: '/Users/tester' })
  })
})
