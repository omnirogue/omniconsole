import { describe, expect, it, vi } from 'vitest'

import { bindSessionPrincipal, type TranscriptPrincipal } from './transcript-upload-send'

function session(owner: string | null) {
  return { owner, principalCapture: null as Promise<TranscriptPrincipal | null> | null }
}

describe('bindSessionPrincipal', () => {
  it("returns the owner's current capture and keeps it for the next run", async () => {
    const capture = vi.fn(async () => ({ principal: 'person-a', isCurrent: () => true }))
    const s = session('person-a')
    expect((await bindSessionPrincipal(s, capture))?.principal).toBe('person-a')
    expect((await bindSessionPrincipal(s, capture))?.principal).toBe('person-a')
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it("never returns another person's capture, and re-captures on every run while mismatched", async () => {
    let n = 0
    const capture = vi.fn(async () => ({
      principal: `person-b-${(n += 1)}`,
      isCurrent: () => true
    }))
    const s = session('person-a')
    expect(await bindSessionPrincipal(s, capture)).toBeNull()
    expect(await bindSessionPrincipal(s, capture)).toBeNull()
    expect(await bindSessionPrincipal(s, capture)).toBeNull()
    expect(capture).toHaveBeenCalledTimes(3)
    expect(s.principalCapture).toBeNull()
  })

  it('drops a stale owner capture (old sign-in epoch) so the next run captures afresh', async () => {
    let epoch = 1
    const capture = vi.fn(async () => {
      const bound = epoch
      return { principal: 'person-a', isCurrent: () => epoch === bound }
    })
    const s = session('person-a')
    expect(await bindSessionPrincipal(s, capture)).not.toBeNull()
    epoch = 2
    expect(await bindSessionPrincipal(s, capture)).toBeNull()
    expect(s.principalCapture).toBeNull()
    const fresh = await bindSessionPrincipal(s, capture)
    expect(fresh?.isCurrent()).toBe(true)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('never binds a session that has no owner, and retries a failed capture', async () => {
    const capture = vi.fn(async () => null)
    expect(await bindSessionPrincipal(session(null), capture)).toBeNull()
    expect(capture).not.toHaveBeenCalled()
    const s = session('person-a')
    expect(await bindSessionPrincipal(s, capture)).toBeNull()
    expect(s.principalCapture).toBeNull()
    expect(await bindSessionPrincipal(s, capture)).toBeNull()
    expect(capture).toHaveBeenCalledTimes(2)
  })
})
