import { describe, expect, it } from 'vitest'
import { assertAutomationPaneAcceptsInput } from './reused-pane-readiness'

describe('assertAutomationPaneAcceptsInput', () => {
  it('refuses a pane showing the Codex resume-lock banner with a fallback-able token', async () => {
    const runtime = {
      readTerminal: async () => ({
        tail: ['■ Conversation interrupted - tell the model what to do differently.', 'R to Retry']
      })
    }
    await expect(assertAutomationPaneAcceptsInput(runtime, 'h')).rejects.toThrow(
      /^terminal_not_writable: Codex could not continue/
    )
  })
  it('accepts an ordinary idle pane and one that cannot be read', async () => {
    await expect(
      assertAutomationPaneAcceptsInput(
        { readTerminal: async () => ({ tail: ['› Ask Codex'] }) },
        'h'
      )
    ).resolves.toBeUndefined()
    await expect(
      assertAutomationPaneAcceptsInput(
        {
          readTerminal: async () => {
            throw new Error('terminal_not_found')
          }
        },
        'h'
      )
    ).resolves.toBeUndefined()
  })
})
