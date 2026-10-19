import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
const state = vi.hoisted(() => ({ current: true }))
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: async () => ({
    ok: true,
    data: {
      bearer: 'fake-credential',
      baseUrl: 'https://omnios.test',
      principal: 'sal',
      isCurrent: () => state.current
    }
  }),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
import { onConsoleCreditsExhausted, requestConsoleWorkflow } from './console-workflow-transport'
const exhausted = {
  error: 'credits_exhausted',
  needed: 576,
  balance: 40,
  period_end: '2026-11-01T00:00:00Z',
  upgrade: { url: 'https://app.omnisi.ai/billing', can_upgrade: false, next_plan: null }
}
beforeEach(() => {
  state.current = true
})
afterEach(() => vi.unstubAllGlobals())
it('publishes a structured 402 from the authenticated transport without changing the refusal', async () => {
  const listener = vi.fn()
  const unsubscribe = onConsoleCreditsExhausted(listener)
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(exhausted), { status: 402 }))
  vi.stubGlobal('fetch', fetch)
  const result = await requestConsoleWorkflow('/api/credits', 'GET', z.unknown())
  expect(result).toMatchObject({ ok: false, error: { status: 402 } })
  expect(listener).toHaveBeenCalledWith(exhausted)
  expect(fetch).toHaveBeenCalledWith(
    'https://omnios.test/api/credits',
    expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer fake-credential' })
    })
  )
  unsubscribe()
  fetch.mockResolvedValue(new Response(JSON.stringify(exhausted), { status: 402 }))
  await requestConsoleWorkflow('/api/credits', 'GET', z.unknown())
  expect(listener).toHaveBeenCalledOnce()
})
it('does not publish 404, malformed errors or an error from a changed sign-in', async () => {
  const listener = vi.fn()
  const unsubscribe = onConsoleCreditsExhausted(listener)
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  for (const [status, body] of [
    [404, exhausted],
    [402, { error: 'other' }]
  ] as const) {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
    await requestConsoleWorkflow('/api/credits', 'GET', z.unknown())
  }
  fetch.mockImplementationOnce(async () => {
    state.current = false
    return new Response(JSON.stringify(exhausted), { status: 402 })
  })
  expect(await requestConsoleWorkflow('/api/credits', 'GET', z.unknown())).toMatchObject({
    ok: false,
    error: { code: 'connection_changed' }
  })
  expect(listener).not.toHaveBeenCalled()
  unsubscribe()
})
it('keeps the server refusal when a push subscriber fails', async () => {
  const unsubscribe = onConsoleCreditsExhausted(() => {
    throw new Error('window closed')
  })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(exhausted), { status: 402 }))
  )
  expect(await requestConsoleWorkflow('/api/credits', 'GET', z.unknown())).toMatchObject({
    ok: false,
    error: { status: 402 }
  })
  unsubscribe()
})
