import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderLoginSessions } from './provider-login-sessions'
import type { ProviderLoginInteraction } from './provider-login-interaction'

function fixture() {
  let interaction!: ProviderLoginInteraction
  let complete!: () => void
  const signIn = vi.fn((_request, next: ProviderLoginInteraction) => {
    interaction = next
    return new Promise<void>((resolve, reject) => {
      complete = resolve
      next.signal.addEventListener('abort', () => reject(new Error('secret CLI output')), {
        once: true
      })
    })
  })
  const sessions = new ProviderLoginSessions(signIn)
  return { sessions, signIn, interaction: () => interaction, complete: () => complete() }
}

afterEach(() => vi.useRealTimers())

describe('provider sign-in sessions', () => {
  it('exposes only the supported URL and device code to the initiating owner', async () => {
    const f = fixture()
    const start = f.sessions.start('owner-a', { provider: 'codex' })
    await Promise.resolve()
    f.interaction().onOutput(
      'secret refresh_token=hidden https://evil.test/codex/device https://auth.openai.com/codex/device\nABCD-EFGHI'
    )
    expect(f.sessions.status('owner-a', start.id)).toEqual({
      ...start,
      status: 'waiting',
      authorizationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGHI'
    })
    expect(() => f.sessions.status('owner-b', start.id)).toThrow('unavailable')
    expect(() => f.sessions.cancel('owner-b', start.id)).toThrow('unavailable')
    expect(() => f.sessions.submitCode('owner-b', start.id, 'code')).toThrow('unavailable')
    f.complete()
    await vi.waitFor(() => expect(f.sessions.status('owner-a', start.id).status).toBe('complete'))
    expect(f.sessions.status('owner-a', start.id).authorizationUrl).toBeUndefined()
  })

  it('handles Claude browser fallback input without returning it in status', async () => {
    const f = fixture()
    const start = f.sessions.start('owner', { provider: 'claude', accountId: 'sal' })
    await Promise.resolve()
    const input = vi.fn()
    f.interaction().setInput?.(input)
    f.interaction().onOutput(
      'https://claude.com/cai/oauth/authorize?state=test&code_challenge=challenge\nPaste code here if prompted:'
    )
    expect(f.sessions.status('owner', start.id).canSubmitCode).toBe(true)
    expect(() => f.sessions.submitCode('owner', start.id, 'code\ncommand')).toThrow('Invalid')
    const state = f.sessions.submitCode('owner', start.id, 'oauth-code#state')
    expect(input).toHaveBeenCalledWith('oauth-code#state')
    expect(JSON.stringify(state)).not.toContain('oauth-code')
    f.sessions.cancel('owner', start.id)
    await vi.waitFor(() => expect(f.sessions.status('owner', start.id).status).toBe('cancelled'))
    expect(f.sessions.status('owner', start.id).error).toBeUndefined()
  })

  it('coalesces a retried start and prevents competing provider logins', async () => {
    const f = fixture()
    const request = { provider: 'codex' as const, accountId: 'account' }
    const start = f.sessions.start('owner', request)
    expect(f.sessions.start('owner', request)).toEqual(start)
    expect(() => f.sessions.start('other', request)).toThrow('already running')
    await Promise.resolve()
    expect(f.signIn).toHaveBeenCalledTimes(1)
    f.sessions.stop()
  })

  it('expires abandoned logins and redacts provider failure output', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const start = f.sessions.start('owner', { provider: 'claude' })
    await vi.advanceTimersByTimeAsync(240_000)
    expect(f.sessions.status('owner', start.id).status).toBe('cancelled')
    const failed = new ProviderLoginSessions(async () => {
      throw new Error('access_token=secret')
    })
    const state = failed.start('owner', { provider: 'codex' })
    await vi.advanceTimersByTimeAsync(0)
    expect(failed.status('owner', state.id).status).toBe('error')
    expect(JSON.stringify(failed.status('owner', state.id))).not.toContain('secret')
  })
})
