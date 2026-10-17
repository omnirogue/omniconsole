import { describe, expect, it, vi } from 'vitest'
import type { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'
import {
  guardedSessionWrite,
  registerSessionSubprocess,
  routeGuardedWrite,
  routeRevokeWriteFence
} from './session-guarded-write'

const RECEIVER = { pid: 4242, pgid: 4242, startTimeMs: 1_000_000 }

function session(over: Partial<Pick<Session, 'isAlive' | 'shellState'>> = {}) {
  return { isAlive: true, shellState: 'ready', ...over } as unknown as Session
}

describe('guardedSessionWrite', () => {
  it('hands the receiver to the session’s own PTY, which checks and writes', () => {
    const guardedWrite = vi.fn(() => 'written' as const)
    const live = session()
    registerSessionSubprocess(live, { guardedWrite } as unknown as SubprocessHandle)
    expect(guardedSessionWrite(live, 'hi', { receiver: RECEIVER })).toBe('written')
    expect(guardedWrite).toHaveBeenCalledWith('hi', { receiver: RECEIVER })
  })

  it('is unsupported where the PTY cannot check, and refused for an ended or starting session', () => {
    const plain = session()
    registerSessionSubprocess(plain, { write: vi.fn() } as unknown as SubprocessHandle)
    expect(guardedSessionWrite(plain, 'hi', { receiver: RECEIVER })).toBe('unsupported')
    expect(guardedSessionWrite(session(), 'hi', { receiver: RECEIVER })).toBe('unsupported')
    for (const over of [{ isAlive: false }, { shellState: 'pending' as const }]) {
      const guardedWrite = vi.fn(() => 'written' as const)
      const held = session(over)
      registerSessionSubprocess(held, { guardedWrite } as unknown as SubprocessHandle)
      expect(guardedSessionWrite(held, 'hi', { receiver: RECEIVER })).toBe('refused')
      expect(guardedWrite).not.toHaveBeenCalled()
    }
  })
})

describe('routeGuardedWrite', () => {
  const route = (
    outcome: 'written' | 'refused',
    receiver: unknown = RECEIVER,
    fenceToken?: unknown
  ) => {
    const host = { guardedWrite: vi.fn(() => outcome) }
    const attachments = { recordInput: vi.fn() }
    const reply = routeGuardedWrite(
      { host, attachments },
      { sessionId: 's1', data: 'x', receiver, ...(fenceToken !== undefined ? { fenceToken } : {}) }
    )
    return { reply, host, attachments }
  }

  it('records input only for a write that happened', () => {
    const written = route('written')
    expect(written.reply).toEqual({ outcome: 'written' })
    expect(written.attachments.recordInput).toHaveBeenCalledWith('s1')
    const refused = route('refused')
    expect(refused.reply).toEqual({ outcome: 'refused' })
    expect(refused.attachments.recordInput).not.toHaveBeenCalled()
  })

  it('refuses a request without a whole receiver, or with a malformed fence, before the session', () => {
    for (const bad of [route('written', { pid: 4242, pgid: 4242 })]) {
      expect(bad.reply).toEqual({ outcome: 'refused' })
      expect(bad.host.guardedWrite).not.toHaveBeenCalled()
    }
  })

  it('refuses every fenced request before invoking the writer', () => {
    for (const token of ['fence-open', '', 7]) {
      const result = route('written', RECEIVER, token)
      expect(result.reply).toEqual({ outcome: 'unsupported' })
      expect(result.host.guardedWrite).not.toHaveBeenCalled()
      expect(result.attachments.recordInput).not.toHaveBeenCalled()
    }
    expect(routeRevokeWriteFence({ token: 42 })).toEqual({ revoked: false })
  })
})
