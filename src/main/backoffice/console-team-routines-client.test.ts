import { beforeEach, expect, it, vi } from 'vitest'
import { consoleTeamRoutinesClient as client } from './console-team-routines-client'
import { captureConsoleWorkflowPerson } from './console-workflow-person'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'test-person',
      baseUrl: 'https://console.test',
      principal: 'person',
      isCurrent: () => true
    }
  } as never)
})

// list/runs bodies decode as sent; get/share go through the routine schema, which fills in
// members/viewer_role defaults, so their decoded data differs from the raw response body.
it.each([
  ['list', '/api/routines', [], undefined, []],
  [
    'get',
    '/api/routines/rtn_demo_123',
    { id: 'rtn_demo_123' },
    { id: 'rtn_demo_123' },
    { id: 'rtn_demo_123', members: [], viewer_role: null }
  ],
  ['runs', '/api/routines/rtn_demo_123/runs', [], { id: 'rtn_demo_123' }, []],
  [
    'share',
    '/api/routines/rtn_demo_123/share',
    {},
    { id: 'rtn_demo_123', employeeId: 'emp_person' },
    { members: [], viewer_role: null }
  ]
] as const)('calls the signed %s route %s', async (operation, path, body, args, decoded) => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)))
  const send = client[operation] as (args: unknown) => Promise<unknown>
  expect(await send(args)).toEqual({ ok: true, data: decoded })
  expect(fetchMock).toHaveBeenCalledWith(
    `https://console.test${path}`,
    expect.objectContaining({
      method: operation === 'share' ? 'POST' : 'GET',
      headers: expect.objectContaining({
        Authorization: 'Bearer test-person'
      }),
      ...(operation === 'share' ? { body: JSON.stringify({ employee_id: 'emp_person' }) } : {})
    })
  )
})

it.each(['rtn_../secret', 'rtn_x?admin=1', 'other_123', 'rtn_', `rtn_${'a'.repeat(129)}`])(
  'rejects unsafe routine ID %s before transport',
  async (id) => {
    expect(await client.get({ id })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  }
)
it('rejects a room identity', async () => {
  expect(await client.share({ id: 'rtn_demo', employeeId: 'room_member_1' })).toMatchObject({
    ok: false
  })
  expect(fetchMock).not.toHaveBeenCalled()
})
it.each(['routine_owner_required', 'task_permission_denied', 'company_access_required'])(
  'preserves hub refusal %s',
  async (code) => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: { code, message: 'Hub refusal' } }), {
        status: 403
      })
    )
    expect(await client.share({ id: 'rtn_demo', employeeId: 'emp_person' })).toMatchObject({
      ok: false,
      error: { code, message: 'Hub refusal', status: 403 }
    })
  }
)
it('does not silently decode a failed list as empty', async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ unexpected: [] })))
  expect(await client.list()).toMatchObject({
    ok: false,
    error: { code: 'invalid_response' }
  })
})

it.each(['enable', 'disable'] as const)(
  'POSTs %s without a body and decodes the routine',
  async (verb) => {
    const body = {
      id: 'rtn_demo_123',
      status: verb === 'enable' ? 'active' : 'disabled',
      next_due: '2026-09-19T09:00:00Z',
      viewer_role: 'owner',
      members: []
    }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)))
    expect(await client[verb]({ id: body.id })).toEqual({
      ok: true,
      data: body
    })
    expect(fetchMock).toHaveBeenCalledWith(
      `https://console.test/api/routines/${body.id}/${verb}`,
      expect.objectContaining({ method: 'POST' })
    )
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('body')
  }
)
it.each(['enable', 'disable'] as const)(
  'rejects invalid IDs for %s before transport',
  async (verb) => {
    for (const id of ['other_123', 'rtn_bad/path', 'rtn_', `rtn_${'a'.repeat(129)}`]) {
      expect(await client[verb]({ id })).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' }
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  }
)
it.each(['enable', 'disable'] as const)('surfaces the hub %s refusal', async (verb) => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        detail: {
          code: 'activation_not_ready',
          message: 'Proof of life required'
        }
      }),
      { status: 409 }
    )
  )
  expect(await client[verb]({ id: 'rtn_demo' })).toMatchObject({
    ok: false,
    error: { message: 'Proof of life required', status: 409 }
  })
})
