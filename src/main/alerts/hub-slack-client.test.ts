import { beforeEach, describe, expect, it, vi } from 'vitest'
const request = vi.hoisted(() => vi.fn())
const capture = vi.hoisted(() => vi.fn())
vi.mock('../backoffice/console-workflow-transport', () => ({ requestConsoleWorkflow: request }))
vi.mock('../backoffice/console-workflow-person', () => ({ captureConsoleWorkflowPerson: capture }))
import { HubSlackClient } from './hub-slack-client'
const payload = {
  kind: 'channel' as const,
  channel: 'C123',
  text: 'Finished',
  runLink: 'omni://automation/a/run/r',
  runId: 'r',
  automationId: 'a'
}
beforeEach(() => {
  vi.clearAllMocks()
  capture.mockResolvedValue({
    ok: true,
    data: { principal: 'person1', baseUrl: 'https://hub.example', isCurrent: () => true }
  })
})
describe('hub Slack adapter', () => {
  it.each([
    { authenticated: false, connection: null },
    { authenticated: true, connection: null },
    {
      authenticated: true,
      connection: { id: 'T1', title: 'Company' },
      ownerEmail: 'owner@example.com'
    }
  ])('maps account state $authenticated / $connection', async (status) => {
    request.mockResolvedValue({ ok: true, data: status })
    expect(await new HubSlackClient().status()).toEqual(status)
  })
  it('caches channel choices for ten minutes, with refresh and person isolation', async () => {
    vi.useFakeTimers()
    try {
      const rows = [{ id: 'C1', name: 'test-alerts' }]
      request.mockResolvedValue({ ok: true, data: rows })
      const client = new HubSlackClient()
      expect(await client.listChannels()).toEqual(rows)
      await client.listChannels()
      expect(request).toHaveBeenCalledTimes(1)
      await client.listChannels(true)
      expect(request).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(600_001)
      await client.listChannels()
      capture.mockResolvedValue({
        ok: true,
        data: { principal: 'person2', baseUrl: 'https://hub.example', isCurrent: () => true }
      })
      await client.listChannels()
      expect(request).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })
  it.each(['timeout', 'missing connection', 'channel refused'])(
    'never rejects or retries: %s',
    async (message) => {
      request.mockResolvedValue({ ok: false, error: { message } })
      await expect(new HubSlackClient().send(payload)).resolves.toEqual({
        ok: false,
        error: message
      })
      expect(request).toHaveBeenCalledTimes(1)
      expect(request.mock.calls[0][4]).toBe(10_000)
      expect(request.mock.calls[0][8]).toBeInstanceOf(AbortSignal)
    }
  )
  it('contains transport rejections and refuses invalid payloads', async () => {
    request.mockRejectedValue(new Error('network'))
    await expect(new HubSlackClient().send(payload)).resolves.toMatchObject({ ok: false })
    await expect(new HubSlackClient().send({ ...payload, channel: '' })).resolves.toMatchObject({
      ok: false
    })
    expect(request).toHaveBeenCalledTimes(1)
  })
})

it('bounds even stalled transports and sends under a captured identity', async () => {
  vi.useFakeTimers()
  try {
    request.mockImplementation(() => new Promise(() => {}))
    const client = new HubSlackClient()
    const status = client.status()
    const sent = client.send(payload)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(status).resolves.toMatchObject({ authenticated: false, error: expect.any(String) })
    await expect(sent).resolves.toMatchObject({ ok: false, error: expect.any(String) })
    request.mockResolvedValue({ ok: true, data: { ok: true } })
    const person = {
      principal: 'captured',
      baseUrl: 'https://hub.example',
      bearer: 'test',
      isCurrent: () => true
    }
    await client.send(payload, person)
    expect(request.mock.calls.at(-1)?.[6]).toBe('captured')
    expect(request.mock.calls.at(-1)?.[7]).toBe(person.isCurrent)
  } finally {
    vi.useRealTimers()
  }
})
