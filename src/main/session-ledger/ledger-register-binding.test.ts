import { describe, expect, it, vi } from 'vitest'
import { LedgerRegisterBinding } from './ledger-register-binding'

const ROW = 'als_0123456789abcdef01234567'

type Answer =
  | { ok: true }
  | { ok: false; reason: 'rejected' | 'signed-out' | 'unavailable' | 'principal-mismatch' }

function client(results: Answer[] = []) {
  const calls: [string, unknown, string][] = []
  return {
    calls,
    register: vi.fn(async (ledgerId: string, body: unknown, account: string) => {
      calls.push([ledgerId, body, account])
      return results.shift() ?? { ok: true as const }
    })
  }
}

describe('register binding', () => {
  it("holds a register for an ownerless row until the row is confirmed to be the signed-in person's", async () => {
    let current: string | null = null
    const owner = { value: null as string | null }
    const api = client()
    const binding = new LedgerRegisterBinding(
      api,
      () => current,
      (_ledgerId, account) => owner.value === account
    )
    binding.send({ ledgerId: ROW, account: null }, { waiting: true })
    await binding.retry()
    expect(api.calls).toEqual([])
    expect(binding.heldCount()).toBe(1)

    // Signing in does not claim it; the row must carry that owner.
    current = 'principal-a'
    await binding.retry()
    expect(api.calls).toEqual([])
    expect(binding.heldCount()).toBe(1)

    owner.value = 'principal-a'
    await binding.retry()
    expect(api.calls).toEqual([[ROW, { waiting: true }, 'principal-a']])
    expect(binding.heldCount()).toBe(0)
  })

  it('never sends an ownerless register under a principal the row does not belong to', async () => {
    const api = client()
    const binding = new LedgerRegisterBinding(
      api,
      () => 'principal-b',
      () => false
    )
    binding.send({ ledgerId: ROW, account: null }, { repo: 'github.com/Org/Repo' })
    await binding.retry()
    expect(api.calls).toEqual([])
    expect(binding.heldCount()).toBe(1)
  })

  it('keeps a bound register through a signed-out or unavailable answer', async () => {
    const api = client([
      { ok: false, reason: 'signed-out' },
      { ok: false, reason: 'unavailable' }
    ])
    const binding = new LedgerRegisterBinding(api, () => 'principal-a')
    binding.send({ ledgerId: ROW, account: 'principal-a' }, { waiting: true })
    await binding.retry()
    expect(binding.heldCount()).toBe(1)
    await binding.retry()
    expect(binding.heldCount()).toBe(1)
    await binding.retry()
    expect(binding.heldCount()).toBe(0)
    expect(api.calls).toHaveLength(3)
  })

  it('gives up a console-rejected register only after bounded attempts, and says so', async () => {
    const warn = vi.fn()
    const api = client([
      { ok: false, reason: 'rejected' },
      { ok: false, reason: 'rejected' },
      { ok: false, reason: 'rejected' }
    ])
    const binding = new LedgerRegisterBinding(
      api,
      () => 'principal-a',
      () => false,
      warn
    )
    binding.send({ ledgerId: ROW, account: 'principal-a' }, { waiting: true })
    await binding.retry()
    expect(binding.heldCount()).toBe(1)
    await binding.retry()
    expect(binding.heldCount()).toBe(1)
    await binding.retry()
    expect(binding.heldCount()).toBe(0)
    expect(api.calls).toHaveLength(3)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('giving up'))
  })

  it("never folds an ownerless body into an owner's body for the same row", async () => {
    const api = client()
    const binding = new LedgerRegisterBinding(
      api,
      () => 'principal-a',
      () => false
    )
    binding.send({ ledgerId: ROW, account: null }, { waiting: true })
    binding.send({ ledgerId: ROW, account: 'principal-a' }, { repo: 'github.com/Org/Repo' })
    await binding.retry()
    expect(api.calls).toEqual([[ROW, { repo: 'github.com/Org/Repo' }, 'principal-a']])
    expect(binding.heldCount()).toBe(1)
  })
})
