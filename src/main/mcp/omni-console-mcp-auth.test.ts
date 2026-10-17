import { afterEach, describe, expect, it, vi } from 'vitest'
import { isOmniConsoleMcpSignedIn, setOmniConsoleMcpSignInResolver } from './omni-console-mcp-auth'

afterEach(() => setOmniConsoleMcpSignInResolver(null))

describe('MCP sign-in capability', () => {
  it('does not enable defaults on a Node host without an authenticated desktop owner', () => {
    expect(isOmniConsoleMcpSignedIn('/node-profile')).toBe(false)
  })

  it('asks the desktop owner for the current profile on every launch, including sign-out', () => {
    const resolve = vi.fn(() => true)
    setOmniConsoleMcpSignInResolver(resolve)
    expect(isOmniConsoleMcpSignedIn('/desktop-profile')).toBe(true)
    expect(resolve).toHaveBeenCalledWith('/desktop-profile')
    resolve.mockReturnValue(false)
    expect(isOmniConsoleMcpSignedIn('/desktop-profile')).toBe(false)
  })

  it('removes authenticated eligibility when the owner is detached', () => {
    setOmniConsoleMcpSignInResolver(() => true)
    setOmniConsoleMcpSignInResolver(null)
    expect(isOmniConsoleMcpSignedIn()).toBe(false)
  })
})
