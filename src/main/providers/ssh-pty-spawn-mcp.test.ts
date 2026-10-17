import { describe, expect, it, vi } from 'vitest'
import { buildSshPtySpawnRequest } from './ssh-pty-spawn-request'
// Why: a Claude spawn here must not write this machine's real Claude config.
vi.mock('../claude-accounts/claude-diff-panel-pty', () => ({
  keepClaudeDiffPanelClosedForPty: vi.fn()
}))

const auth = vi.hoisted(() => ({ signedIn: false }))
vi.mock('../mcp/omni-console-mcp-launch-context', () => ({
  isOmniConsoleMcpDefaultRequested: () => auth.signedIn
}))

describe('SSH MCP default request', () => {
  it('sends only an optional boolean to the execution host for a signed-in person', () => {
    auth.signedIn = true
    try {
      const request = buildSshPtySpawnRequest({
        options: { cols: 80, rows: 24, launchAgent: 'claude', cwd: '/remote/repo' },
        supportsCreateOperation: false
      })
      expect(request.omniConsoleMcpDefault).toBe(true)
      expect(request.env).not.toHaveProperty('OMNI_ACCESS_TOKEN')
    } finally {
      auth.signedIn = false
    }
  })

  it('keeps the legacy request shape when signed out', () => {
    const request = buildSshPtySpawnRequest({
      options: { cols: 80, rows: 24 },
      supportsCreateOperation: false
    })
    expect(request).not.toHaveProperty('omniConsoleMcpDefault')
  })
})
