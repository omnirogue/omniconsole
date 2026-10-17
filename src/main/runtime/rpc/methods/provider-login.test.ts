import { describe, expect, it, vi } from 'vitest'
import { ProviderLoginSessions } from '../../../provider-login-sessions'
import { PROVIDER_LOGIN_METHODS } from './provider-login'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { RpcContext } from '../core'

function fixture() {
  const signIn = vi.fn(async () => {})
  const sessions = new ProviderLoginSessions(signIn)
  const runtime = { providerLoginSessions: sessions } as unknown as OrcaRuntimeService
  const invoke = (method: string, params: unknown, caller: Partial<RpcContext> = {}) =>
    PROVIDER_LOGIN_METHODS.find((entry) => entry.name === method)!.handler(
      params,
      { runtime, ...caller },
      () => {}
    )
  return { sessions, signIn, invoke }
}

describe('provider sign-in RPC ownership', () => {
  it('allows a paired runtime to authenticate on its host while isolating the session', async () => {
    const f = fixture()
    const owner = { clientKind: 'runtime' as const, authenticatedCallerFingerprint: 'paired-a' }
    const request = { provider: 'claude', runtime: 'host', accountId: 'managed-account' }
    const start = (await f.invoke('accounts.login.start', request, owner)) as { id: string }
    expect(f.signIn).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(() =>
      f.invoke(
        'accounts.login.status',
        { id: start.id },
        { ...owner, authenticatedCallerFingerprint: 'paired-b' }
      )
    ).toThrow('unavailable')
    expect(() => f.invoke('accounts.login.cancel', { id: start.id })).toThrow('unavailable')
    expect(await f.invoke('accounts.login.status', { id: start.id }, owner)).toMatchObject({
      id: start.id
    })
  })

  it('refuses an unidentified remote before spawning any authentication process', () => {
    const f = fixture()
    expect(() =>
      f.invoke('accounts.login.start', { provider: 'codex' }, { clientKind: 'runtime' })
    ).toThrow('authenticated runtime')
    expect(f.signIn).not.toHaveBeenCalled()
  })
})
