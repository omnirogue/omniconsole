import { describe, expect, it } from 'vitest'
import { sessionChainErrorMessage } from './session-chain-error'

describe('session chain failure display', () => {
  it.each(['terminal_gone', 'terminal_handle_stale', 'terminal_pane_owner_unverified'])(
    'explains %s without treating lost contact as process death',
    (code) => {
      const message = sessionChainErrorMessage(
        `Error invoking remote method 'terminal:wait': Error: ${code}`
      )
      expect(message).toContain('Reopen it to check the work')
      expect(message).not.toMatch(/terminal_|stopped|exited/)
    }
  )

  it.each(['timeout', 'ECONNREFUSED', 'SSH connection lost, reconnecting'])(
    'leaves work unverifiable after %s',
    (code) => {
      const message = sessionChainErrorMessage(code)
      expect(message).toContain('agent may still be working')
      expect(message).not.toMatch(/agent stopped|agent exited/)
    }
  )

  it('distinguishes an opened agent with missing instructions from a failed launch', () => {
    const message = sessionChainErrorMessage(
      'The next session started, but its instruction could not be sent.'
    )
    expect(message).toContain('The next agent opened')
    expect(message).toContain('send the instruction there')
    expect(message).not.toContain('try Add Next again')
  })

  it('preserves a specific human-readable explanation from the service', () => {
    expect(sessionChainErrorMessage('You no longer have access to this task.')).toBe(
      'You no longer have access to this task.'
    )
  })

  it.each([null, '', 'unrecognized_launch_failure'])(
    'provides a useful fallback for %s',
    (error) => {
      expect(sessionChainErrorMessage(error)).toContain('Open the conversation to review')
    }
  )
})
