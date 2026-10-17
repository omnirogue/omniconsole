import { afterEach, describe, expect, it, vi } from 'vitest'
import { isElectronOmniConsoleMcpSignedIn } from './electron-omni-console-mcp-auth'

const state = vi.hoisted(() => ({
  configured: true,
  index: { activeProfileId: 'sal', profiles: [{ id: 'sal', cloud: { userId: 'sal' } }] },
  session: vi.fn(() => ({ status: 'found', session: { accessToken: 'never-forward-this' } }))
}))
vi.mock('../omni-profiles/profile-cloud-auth-config', () => ({
  getOrcaCloudAuthConfig: () => ({ configured: state.configured })
}))
vi.mock('../omni-profiles/profile-cloud-session-store', () => ({
  readOrcaCloudSession: state.session
}))
vi.mock('../omni-profiles/profile-index-store', () => ({ readProfileIndex: () => state.index }))

afterEach(() => {
  state.configured = true
  state.session.mockReset()
  state.session.mockReturnValue({ status: 'found', session: { accessToken: 'never-forward-this' } })
})

describe('MCP signed-in eligibility', () => {
  it('returns only a boolean for the active profile, without forwarding its session token', () => {
    expect(isElectronOmniConsoleMcpSignedIn('/profile-data')).toBe(true)
    expect(state.session).toHaveBeenCalledWith('sal', '/profile-data')
  })

  it('does not inspect session credentials when omnios is unconfigured', () => {
    state.configured = false
    expect(isElectronOmniConsoleMcpSignedIn('/profile-data')).toBe(false)
    expect(state.session).not.toHaveBeenCalled()
  })

  it('requires a current session after sign-out', () => {
    state.session.mockReturnValue({ status: 'missing', session: { accessToken: '' } })
    expect(isElectronOmniConsoleMcpSignedIn('/profile-data')).toBe(false)
  })
})
