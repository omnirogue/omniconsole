import { describe, expect, it } from 'vitest'
import {
  AGENT_START_CONNECT_SETTLE_GRACE_MS,
  TRANSPORT_CONNECT_SETTLE_GRACE_MS,
  isTransportConnectStillSettling
} from './pty-connect-limits'

// Why: an agent start can wait minutes in main's admission queue (3 per 10 s). Keystrokes into
// that pane used to count as a dead binding after 60 s and remount it, which destroyed the
// transport, cancelled the queued start and queued it again at the back.

describe('input recovery connect settle grace', () => {
  it('keeps treating a queued agent start as settling past the plain 60 s grace', () => {
    const since = 1_000
    const now = since + TRANSPORT_CONNECT_SETTLE_GRACE_MS + 30_000
    const connect = { connectInFlightSince: since, now }
    expect(isTransportConnectStillSettling({ ...connect, agentStartInFlight: true })).toBe(true)
    expect(isTransportConnectStillSettling({ ...connect, agentStartInFlight: false })).toBe(false)
  })

  it('still recovers a wedged agent start past its ceiling, and never without a connect', () => {
    expect(
      isTransportConnectStillSettling({
        connectInFlightSince: 0,
        agentStartInFlight: true,
        now: AGENT_START_CONNECT_SETTLE_GRACE_MS
      })
    ).toBe(false)
    expect(
      isTransportConnectStillSettling({
        connectInFlightSince: null,
        agentStartInFlight: true,
        now: 5
      })
    ).toBe(false)
  })
})
