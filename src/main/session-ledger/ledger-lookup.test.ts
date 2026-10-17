import { afterEach, describe, expect, it } from 'vitest'
import { LedgerPaneRegistry } from './ledger-identity'
import { paneForLedgerId, setActiveLedgerPaneRegistry } from './ledger-lookup'

afterEach(() => setActiveLedgerPaneRegistry(null))

describe('linked session execution-host provenance', () => {
  it.each([
    [null, 'local'],
    ['host with spaces|and pipes', 'ssh:host%20with%20spaces%7Cand%20pipes']
  ])('qualifies a known connection (%s)', (connectionId, executionHostId) => {
    const registry = new LedgerPaneRegistry()
    const { entry } = registry.stamp('pane')
    registry.update('pane', { connectionId, nativeSessionId: 'native' })
    setActiveLedgerPaneRegistry(registry)
    expect(paneForLedgerId(entry.ledgerId)).toEqual({
      paneKey: 'pane',
      nativeSessionId: 'native',
      executionHostId
    })
  })

  it('does not infer a local host from missing ownership', () => {
    const registry = new LedgerPaneRegistry()
    const { entry } = registry.stamp('pane')
    setActiveLedgerPaneRegistry(registry)
    expect(paneForLedgerId(entry.ledgerId)).toEqual({ paneKey: 'pane' })
    expect(paneForLedgerId('missing')).toBeNull()
  })
})
