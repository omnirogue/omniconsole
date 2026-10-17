import { beforeEach, expect, it, vi } from 'vitest'
import { consoleTeamRoutinesClient as client } from './console-team-routines-client'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import type { TeamRoutineCreateRequest } from '../../shared/console-team-routines-contract'
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetchMock = vi.fn<typeof fetch>()
const body: TeamRoutineCreateRequest = {
  name: 'Daily summary',
  description: '',
  trigger_type: 'cron',
  trigger_config: { cron: '0 14 * * *' },
  task_template: { title: 'Daily summary', prompt: 'Summarize activity' },
  status: 'disabled',
  scope: 'omnirogue/marketing',
  purpose: 'ai'
}
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
it('posts exactly the BFF required/allowed body and returns the hub ID', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ id: 'rtn_new', status: 'disabled' }), {
      status: 201
    })
  )
  expect(await client.create(body)).toMatchObject({
    ok: true,
    data: { id: 'rtn_new' }
  })
  expect(fetchMock).toHaveBeenCalledWith(
    'https://console.test/api/routines',
    expect.objectContaining({ method: 'POST', body: JSON.stringify(body) })
  )
  const sent = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
  expect(sent).toEqual(body)
  const allowed = [
    'name',
    'description',
    'trigger_type',
    'trigger_config',
    'task_template',
    'status',
    'project_id',
    'gate_type',
    'gate_config',
    'hard_cap_type',
    'hard_cap_value',
    'notification_target',
    'scope',
    'purpose'
  ]
  expect(Object.keys(sent).every((key) => allowed.includes(key))).toBe(true)
  for (const key of ['name', 'trigger_type', 'trigger_config', 'task_template', 'status']) {
    expect(sent).toHaveProperty(key)
  }
})
it('preserves the scope error verbatim', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ detail: 'No active department matches marketing' }), {
      status: 400
    })
  )
  expect(await client.create(body)).toMatchObject({
    ok: false,
    error: { message: 'No active department matches marketing', status: 400 }
  })
})
it.each([{ status: 'active' }, { trigger_type: 'manual' }, { unexpected: true }])(
  'refuses invalid creation fields %j',
  async (patch) => {
    expect(await client.create({ ...body, ...patch } as TeamRoutineCreateRequest)).toMatchObject({
      ok: false
    })
    expect(fetchMock).not.toHaveBeenCalled()
  }
)
it('requires a usable hub ID', async () => {
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201 }))
  expect(await client.create(body)).toMatchObject({
    ok: false,
    error: { code: 'invalid_response' }
  })
})
