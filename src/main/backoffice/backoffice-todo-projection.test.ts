import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchBackofficeTodo } from './backoffice-work'

vi.mock('./backoffice-config', () => ({
  getBackofficeSnapshot: () => ({
    configured: true,
    baseUrl: 'https://omnios.example.com',
    message: ''
  })
}))
vi.mock('../omni-profiles/profile-cloud-auth-config', () => ({
  getOrcaCloudAuthConfig: () => ({ configured: false })
}))
vi.mock('../omni-profiles/profile-index-store', () => ({ ensureActiveOrcaProfile: vi.fn() }))
vi.mock('../omni-profiles/profile-storage-paths', () => ({ getProfileUserDataPath: vi.fn() }))
vi.mock('../omni-profiles/profile-cloud-session-refresh', () => ({
  runWithFreshOrcaCloudSession: vi.fn()
}))

afterEach(() => vi.unstubAllGlobals())

describe('backoffice todo page positions', () => {
  it.each([
    [410, '{"detail":"gone"}'],
    [422, '{"detail":"that page is gone","tag":"todo-page-stale"}']
  ])('answers an expired position (%s) as stale, never as a failure', async (status, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })
      )
    )
    const result = await fetchBackofficeTodo({ cursor: 'eyJvIjoyMDB9' })
    expect(result).toMatchObject({ ok: false, stale: true })
  })

  it('cancels the body of an expired position instead of leaving the stream open', async () => {
    const cancel = vi.fn(async () => undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 410,
            body: { cancel },
            json: async () => ({})
          }) as unknown as Response
      )
    )
    const result = await fetchBackofficeTodo({ cursor: 'eyJvIjoyMDB9' })
    expect(result).toMatchObject({ ok: false, stale: true })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('keeps any other refusal a plain failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 500 }))
    )
    const result = await fetchBackofficeTodo({ cursor: 'eyJvIjoyMDB9' })
    expect(result).toMatchObject({ ok: false, message: 'The backoffice answered HTTP 500.' })
    expect(result.ok === false && result.stale).toBeFalsy()
  })
})

describe('backoffice todo hub projection', () => {
  it.each([0, 19])('preserves the hub state revision %s', async (revision) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          items: [
            {
              task_id: 'btk_1234',
              title: 'Create campaign content',
              state_revision: revision,
              next_action: 'Create the first draft'
            }
          ]
        })
      )
    )

    const result = await fetchBackofficeTodo()

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.items[0]).toMatchObject({
      task_id: 'btk_1234',
      state_revision: revision,
      next_action: 'Create the first draft'
    })
  })

  it.each([undefined, null, '7', -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'keeps an absent or invalid revision unknown: %s',
    async (revision) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            items: [{ task_id: 'btk_1234', title: 'Existing card', state_revision: revision }]
          })
        )
      )

      const result = await fetchBackofficeTodo()

      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.items[0].state_revision).toBeNull()
    }
  )
})
