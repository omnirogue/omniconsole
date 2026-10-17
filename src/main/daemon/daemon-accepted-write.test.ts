import { describe, expect, it, vi } from 'vitest'
import { acknowledgeDaemonWrite } from './daemon-accepted-write'

describe('owning PTY acceptance', () => {
  it('waits for an explicit true receipt, never a socket-flush-shaped result', async () => {
    for (const result of [{}, { accepted: false }, { accepted: true }]) {
      const request = vi.fn(async () => result)
      expect(await acknowledgeDaemonWrite({ request } as never, () => {}, 'p', '\r')).toBe(
        'accepted' in result && result.accepted === true
      )
      expect(request).toHaveBeenCalledExactlyOnceWith('write', {
        sessionId: 'p',
        data: '\r',
        requireAccepted: true
      })
    }
  })
  it('never repeats a write after an uncertain response', async () => {
    const request = vi.fn(async () => {
      throw new Error('socket closed before reply')
    })
    expect(await acknowledgeDaemonWrite({ request }, () => {}, 'p', '\r')).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('does not reconcile against a provider replaced while its reply was in flight', async () => {
    let current = true
    const request = vi.fn(async () => {
      current = false
      return { accepted: true }
    })
    expect(
      await acknowledgeDaemonWrite({ request } as never, () => {}, 'p', '\r', {
        isCurrent: () => current
      })
    ).toBe(false)
  })
})

it('sends legacy input once in order without requiring a capability round trip', async () => {
  const writes: string[] = []
  let finish!: (value: unknown) => void
  const request = vi.fn((_type: string, payload: { data: string }) => {
    writes.push(payload.data)
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const accepted = acknowledgeDaemonWrite({ request } as never, () => {}, 'p', '\r')
  writes.push('next command')
  expect(writes).toEqual(['\r', 'next command'])
  finish({})
  await expect(accepted).resolves.toBe(false)
  expect(request).toHaveBeenCalledExactlyOnceWith('write', {
    sessionId: 'p',
    data: '\r',
    requireAccepted: true
  })
})

it('never retries an unsupported or failed request', async () => {
  const request = vi.fn(async () => {
    throw new Error('Unknown request type')
  })
  expect(await acknowledgeDaemonWrite({ request }, () => {}, 'p', '\r')).toBe(false)
  expect(request).toHaveBeenCalledTimes(1)
})
