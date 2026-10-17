import { describe, expect, it, vi } from 'vitest'
import { withAutomation } from './session-host-control-write'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

describe('a folder or computer override', () => {
  it('switches automation off keeping its other limits, and back on as an empty, newer override', () => {
    const off = withAutomation({ ops: { safeYesPerDay: 1 } }, 'ops', true)
    expect(off).toEqual({ ops: { safeYesPerDay: 1, automation: 'off' } })
    expect(withAutomation(off, 'ops', false)).toEqual({ ops: { safeYesPerDay: 1 } })
    // Why kept, empty: publishing it is how "on again" reaches the other Macs.
    expect(withAutomation({ cs: { automation: 'off' } }, 'cs', false)).toEqual({ cs: {} })
  })
})
