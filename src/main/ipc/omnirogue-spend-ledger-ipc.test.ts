import { describe, expect, it, vi } from 'vitest'
import { OmniRogueSessionSpendLedger } from '../omnirogue-account/omnirogue-session-spend-ledger'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
    removeHandler: (channel: string) => mocks.handlers.delete(channel)
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }]
  }
}))

const { registerOmniRogueSpendLedgerIpc } = await import('./omnirogue-spend-ledger-ipc')

describe('registerOmniRogueSpendLedgerIpc', () => {
  it('lists session spend and broadcasts changes until unsubscribed', () => {
    const ledger = new OmniRogueSessionSpendLedger({ now: () => 1_000 })
    const unsubscribe = registerOmniRogueSpendLedgerIpc(ledger)
    ledger.setBudget('session-1', 100)
    ledger.settle('session-1', 'request-1', 30, 'claude-opus-5-5')

    expect(mocks.handlers.get('omnirogue:spend:list-sessions')?.()).toEqual([
      {
        sessionId: 'session-1',
        spentCredits: 30,
        reservedCredits: 0,
        budgetCredits: 100,
        requestCount: 1,
        updatedAt: 1_000
      }
    ])
    expect(mocks.send).toHaveBeenLastCalledWith(
      'omnirogue:spend:session-changed',
      expect.objectContaining({ sessionId: 'session-1', spentCredits: 30 })
    )

    unsubscribe()
    const sent = mocks.send.mock.calls.length
    ledger.settle('session-1', 'request-2', 5)
    expect(mocks.send).toHaveBeenCalledTimes(sent)
  })

  it('replaces the earlier broadcast when registered again', () => {
    const ledger = new OmniRogueSessionSpendLedger()
    registerOmniRogueSpendLedgerIpc(ledger)
    registerOmniRogueSpendLedgerIpc(ledger)
    mocks.send.mockClear()
    ledger.setBudget('session-2', 10)
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
})
