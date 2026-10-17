import { afterEach, describe, expect, it, vi } from 'vitest'

const jevDecide = vi.fn()
vi.mock('../structured-decisions/jev-rank', () => ({ jevDecide }))

const { sessionPrepJevAsk } = await import('./session-prep-jev')

describe('sessionPrepJevAsk', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns noul scores from one call on the shared ledgered JEV path', async () => {
    jevDecide.mockResolvedValue({ answers: { ready: { type: 'noul', noul: 0.9 } } })
    await expect(
      sessionPrepJevAsk({ outcome: 'ship it' }, { ready: 'Is this ready?' })
    ).resolves.toEqual({ ready: 0.9 })
    expect(jevDecide).toHaveBeenCalledExactlyOnceWith(
      {
        capability: 'session-prep.gate',
        model: 'jev-1.13.0',
        state: { outcome: 'ship it' },
        questions: { ready: { type: 'noul', instructions: 'Is this ready?' } }
      },
      { caller: 'session-prep.gate' }
    )
  })

  it('throws when JEV is unavailable or an answer is missing', async () => {
    jevDecide.mockResolvedValueOnce({ failed: 'JEV is turned off on this computer' })
    await expect(sessionPrepJevAsk({}, { ready: 'ready?' })).rejects.toThrow('turned off')
    jevDecide.mockResolvedValueOnce({ failed: 'no TypeSafe API key (TYPESAFE_API_KEY)' })
    await expect(sessionPrepJevAsk({}, { ready: 'ready?' })).rejects.toThrow('TYPESAFE_API_KEY')
    jevDecide.mockResolvedValueOnce({ answers: {} })
    await expect(sessionPrepJevAsk({}, { ready: 'ready?' })).rejects.toThrow('did not answer')
  })
})
