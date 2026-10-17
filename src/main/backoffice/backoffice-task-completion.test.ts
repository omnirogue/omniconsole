import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { completeBackofficeTask } from './backoffice-work'
import { currentBearerToken } from './backoffice-auth'
import { getBackofficeSnapshot } from './backoffice-config'

vi.mock('./backoffice-auth', () => ({ currentBearerToken: vi.fn() }))
vi.mock('./backoffice-config', () => ({ getBackofficeSnapshot: vi.fn() }))

const CONFIGURED = { configured: true as const, baseUrl: 'https://omnios.example.com', message: '' }
const TASK = 'btk_00f0e485b48440dd93dc'

describe('completeBackofficeTask', () => {
  beforeEach(() => {
    vi.mocked(getBackofficeSnapshot).mockReturnValue(CONFIGURED as never)
    vi.mocked(currentBearerToken).mockResolvedValue('signed-person-token')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('patches the Hub card with its observed revision and signed-person bearer', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(completeBackofficeTask(TASK, 7)).resolves.toEqual({ ok: true })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://omnios.example.com/api/collab/board/${TASK}`)
    expect(init).toMatchObject({
      method: 'PATCH',
      redirect: 'error',
      body: JSON.stringify({ expected_revision: 7, status: 'done' })
    })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer signed-person-token')
  })

  it('names the result ref on the done filing and flags the done-gate refusal', async () => {
    const refused = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: `task ${TASK} cannot be done without evidence (it names an owner and acceptance criteria)`
            }
          }),
          { status: 400 }
        )
    )
    vi.stubGlobal('fetch', refused)
    await expect(completeBackofficeTask(TASK, 7)).resolves.toMatchObject({
      ok: false,
      needsEvidence: true
    })

    const accepted = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', accepted)
    await expect(
      completeBackofficeTask(TASK, 7, ' https://github.com/omnirogue/omni-ide/pull/75 ')
    ).resolves.toEqual({ ok: true })
    const [, init] = accepted.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      expected_revision: 7,
      status: 'done',
      result_ref: 'https://github.com/omnirogue/omni-ide/pull/75'
    })
  })

  it.each([
    ['ses_1234', 1],
    [TASK, -1],
    [TASK, 1.5],
    [TASK, Number.MAX_SAFE_INTEGER + 1]
  ])('refuses an invalid id or revision before any request', async (taskId, revision) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await completeBackofficeTask(taskId as string, revision as number)

    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed when no signed-in person bearer is available', async () => {
    vi.mocked(currentBearerToken).mockResolvedValue(null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await completeBackofficeTask(TASK, 1)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('Sign in')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a stale route response so the renderer can refresh', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: 'The task revision changed.' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' }
          })
      )
    )

    await expect(completeBackofficeTask(TASK, 2)).resolves.toEqual({
      ok: false,
      message: 'The task revision changed.',
      stale: true
    })
  })
})
