import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

describe('readGrokAuthSession', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('node:fs')
    vi.doUnmock('../../shared/grok-session-paths')
  })

  it('parses captured auth without accessing the filesystem', async () => {
    const existsSync = vi.fn()
    const readFileSync = vi.fn()
    vi.doMock('node:fs', () => ({ existsSync, readFileSync }))
    const { parseGrokAuthSession } = await import('./grok-auth')

    expect(
      parseGrokAuthSession(JSON.stringify({ 'https://auth.x.ai': { key: 'captured-token' } }))
    ).toMatchObject({ status: 'ok', session: { accessToken: 'captured-token' } })
    expect(existsSync).not.toHaveBeenCalled()
    expect(readFileSync).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'isolates an explicit home from ambient auth when selected auth exists: %s',
    async (selectedAuthExists) => {
      const ambientHome = join('fleet', 'grok-ambient')
      const selectedHome = join('fleet', 'grok-selected')
      const authFiles = new Map([
        [join(ambientHome, 'auth.json'), { 'https://auth.x.ai': { key: 'ambient-token' } }]
      ])
      if (selectedAuthExists) {
        authFiles.set(join(selectedHome, 'auth.json'), {
          'https://auth.x.ai': { key: 'selected-token' }
        })
      }
      vi.doMock('../../shared/grok-session-paths', () => ({
        resolveGrokHomeDir: vi.fn(() => ambientHome)
      }))
      vi.doMock('node:fs', () => ({
        existsSync: vi.fn((path: string) => authFiles.has(path)),
        readFileSync: vi.fn((path: string) => JSON.stringify(authFiles.get(path)))
      }))
      const { readGrokAuthSession } = await import('./grok-auth')

      if (selectedAuthExists) {
        expect(readGrokAuthSession(selectedHome)).toMatchObject({
          status: 'ok',
          session: { accessToken: 'selected-token' }
        })
      } else {
        expect(readGrokAuthSession(selectedHome)).toEqual({ status: 'missing' })
      }
      expect(readGrokAuthSession()).toMatchObject({
        status: 'ok',
        session: { accessToken: 'ambient-token' }
      })
    }
  )

  it('redacts filesystem paths from auth read failures', async () => {
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => {
        throw new Error(
          'EACCES: permission denied, open /Users/brennanbenson/private/.grok/auth.json'
        )
      })
    }))
    const { readGrokAuthSession } = await import('./grok-auth')

    expect(readGrokAuthSession()).toEqual({
      status: 'error',
      error: 'Unable to read Grok auth file'
    })
  })

  it('treats a token-less auth file as signed out, not an error', async () => {
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => JSON.stringify({ 'https://auth.x.ai::client': { user_id: 'u1' } }))
    }))
    const { readGrokAuthSession } = await import('./grok-auth')

    expect(readGrokAuthSession()).toEqual({ status: 'missing' })
  })

  it('reports malformed auth JSON without parser details', async () => {
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => '{')
    }))
    const { readGrokAuthSession } = await import('./grok-auth')

    expect(readGrokAuthSession()).toEqual({
      status: 'error',
      error: 'Grok auth file is invalid'
    })
  })

  it.each(['https://auth.x.ai', 'https://auth.x.ai::client'])(
    'prefers the %s issuer entry over an earlier alternate issuer',
    async (preferredIssuer) => {
      vi.doMock('node:fs', () => ({
        existsSync: vi.fn(() => true),
        readFileSync: vi.fn(() =>
          JSON.stringify({
            'https://stale.example.com::client': {
              key: 'stale-token',
              user_id: 'stale-user',
              email: 'stale@example.com',
              expires_at: '2099-01-01T00:00:00.000Z'
            },
            [preferredIssuer]: {
              key: 'live-token',
              user_id: 'live-user',
              email: 'live@example.com',
              team_id: 'team-1',
              expires_at: '2099-06-01T00:00:00.000Z',
              oidc_client_id: 'client-1'
            }
          })
        )
      }))
      const { readGrokAuthSession } = await import('./grok-auth')

      expect(readGrokAuthSession()).toEqual({
        status: 'ok',
        session: {
          accessToken: 'live-token',
          userId: 'live-user',
          email: 'live@example.com',
          teamId: 'team-1',
          expiresAtMs: Date.parse('2099-06-01T00:00:00.000Z'),
          oidcClientId: 'client-1'
        }
      })
    }
  )

  it('falls back to the first tokenized entry when no auth.x.ai key exists', async () => {
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() =>
        JSON.stringify({
          'https://alternate.example.com::client': {
            key: 'alt-token',
            user_id: 'alt-user',
            email: 'alt@example.com',
            expires_at: '2099-01-01T00:00:00.000Z'
          }
        })
      )
    }))
    const { readGrokAuthSession } = await import('./grok-auth')

    expect(readGrokAuthSession()).toEqual({
      status: 'ok',
      session: {
        accessToken: 'alt-token',
        userId: 'alt-user',
        email: 'alt@example.com',
        teamId: null,
        expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
        oidcClientId: null
      }
    })
  })

  it('skips an expired auth.x.ai client entry when a fresh one follows it', async () => {
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() =>
        JSON.stringify({
          'https://auth.x.ai::old-client': {
            key: 'expired-token',
            expires_at: '2020-01-01T00:00:00.000Z'
          },
          'https://auth.x.ai::current-client': {
            key: 'fresh-token',
            expires_at: '2099-01-01T00:00:00.000Z'
          }
        })
      )
    }))
    const { readGrokAuthSession } = await import('./grok-auth')

    expect(readGrokAuthSession()).toMatchObject({
      status: 'ok',
      session: { accessToken: 'fresh-token' }
    })
  })

  it('does not resurrect an alternate issuer when an auth.x.ai entry is tokenless', async () => {
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() =>
        JSON.stringify({
          'https://alternate.example.com::client': { key: 'stale-token' },
          'https://auth.x.ai::client': { user_id: 'signed-out-user' }
        })
      )
    }))
    const { readGrokAuthSession } = await import('./grok-auth')

    expect(readGrokAuthSession()).toEqual({ status: 'missing' })
  })
})
