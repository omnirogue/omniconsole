import { describe, expect, it } from 'vitest'
import { RelayTurnLedger } from './relay-owner-turns'
import { hookReport, RELAY_PANE } from './relay-owner-test-host'

describe('the turns a relay hears from its agents', () => {
  it('knows no turn until a finished one, then moves only when another finishes', () => {
    const ledger = new RelayTurnLedger('relay-1')
    ledger.apply(hookReport('working'))
    expect(ledger.revision(RELAY_PANE)).toBeNull()
    ledger.apply(hookReport('done', { providerPromptId: 'p1' }))
    const first = ledger.revision(RELAY_PANE)
    expect(first).toMatch(/^turn:[0-9a-f]{32}$/)
    ledger.apply(hookReport('working'))
    ledger.apply(hookReport('done', { providerPromptId: 'p1' }))
    expect(ledger.revision(RELAY_PANE)).toBe(first)
    ledger.apply(hookReport('done', { providerPromptId: 'p2' }))
    expect(ledger.revision(RELAY_PANE)).not.toBe(first)
  })

  it('hands the next finished turn, with its reply, to whoever waits for it', async () => {
    const ledger = new RelayTurnLedger('relay-1')
    const next = ledger.nextTurn(RELAY_PANE, 1_000)
    ledger.apply(
      hookReport('done', {
        providerPromptId: 'p3',
        payload: {
          state: 'done',
          prompt: '',
          agentType: 'claude',
          lastAssistantMessage: 'Yes, done.'
        }
      })
    )
    expect(await next).toMatchObject({ identity: 'p3', reply: 'Yes, done.' })
    expect(await ledger.nextTurn(RELAY_PANE, 1)).toBeNull()
  })

  it('forgets a pane whose PTY exited', () => {
    const ledger = new RelayTurnLedger('relay-1')
    ledger.apply(hookReport('done', { providerPromptId: 'p1' }))
    ledger.forget(RELAY_PANE)
    expect(ledger.revision(RELAY_PANE)).toBeNull()
    expect(ledger.lastReportAt(RELAY_PANE)).toBeNull()
  })
})
